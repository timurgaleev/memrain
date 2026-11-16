/**
 * Reading a Gmail message resource (`format=full`): its MIME tree, headers,
 * text body and attachment receipts. Pure.
 *
 * The tree is walked iteratively with bounds on depth and part count, so a
 * hostile message cannot recurse the walker or make it spin. An attachment is
 * only ever described (file name, type, size); its `attachmentId` is a fetch
 * handle and is never used or kept. A body part inside an attachment
 * (a forwarded `message/rfc822`) is not mistaken for the message's own text.
 *
 * The API reference does not promise header values with their RFC 2047
 * encoded words decoded, nor body data transcoded to UTF-8, so a text part is
 * read in the charset its Content-Type names and address display names are
 * decoded here (mime-text.ts); decoding text that holds no encoded word
 * changes nothing.
 */
import type { MailAttachment, Person } from "../model.ts";
import { htmlToText } from "../render.ts";
import { contentTypeCharset, decodeCharset, decodeEncodedWords } from "../mime-text.ts";

export interface GmailMimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMimePart[];
}

export const GMAIL_MIME_LIMITS = { depth: 32, parts: 512, headerChars: 65_536, attachments: 100 } as const;

function isPart(v: unknown): v is GmailMimePart {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Every part of the tree in document order with its path ("0", "0.1", ...), bounded. */
export function walkGmailMime(root: GmailMimePart | undefined): Array<{ part: GmailMimePart; path: string }> {
  const out: Array<{ part: GmailMimePart; path: string }> = [];
  if (!isPart(root)) return out;
  const stack = [{ nodes: [root] as unknown[], index: 0, path: "", depth: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    if (out.length >= GMAIL_MIME_LIMITS.parts) break;
    const index = frame.index++;
    const part = frame.nodes[index];
    if (!isPart(part)) continue;
    const path = frame.path ? `${frame.path}.${index}` : String(index);
    out.push({ part, path });
    if (Array.isArray(part.parts) && part.parts.length > 0 && frame.depth < GMAIL_MIME_LIMITS.depth) {
      stack.push({ nodes: part.parts, index: 0, path, depth: frame.depth + 1 });
    }
  }
  return out;
}

/** A header of one part, case-insensitively; "" when absent. */
export function partHeader(part: GmailMimePart | undefined, name: string): string {
  if (!isPart(part) || !Array.isArray(part.headers)) return "";
  const want = name.toLowerCase();
  for (const h of part.headers.slice(0, GMAIL_MIME_LIMITS.parts)) {
    if (h !== null && typeof h === "object" && typeof h.name === "string" && h.name.toLowerCase() === want && typeof h.value === "string") {
      return h.value.slice(0, GMAIL_MIME_LIMITS.headerChars);
    }
  }
  return "";
}

/** Gmail's base64url body data as text in `charset` (UTF-8 when null or unknown). */
export function decodeBase64Url(data: string, charset: string | null = null): string {
  return decodeCharset(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"), charset);
}

/** A part's body data in the charset its Content-Type declares. */
function partText(p: GmailMimePart, data: string): string {
  return decodeBase64Url(data, contentTypeCharset(partHeader(p, "Content-Type")));
}

function isAttachment(p: GmailMimePart): boolean {
  return (typeof p.filename === "string" && p.filename !== "") || p.mimeType === "message/rfc822" || /^attachment\b/i.test(partHeader(p, "Content-Disposition"));
}

/** One html part's text at most this long is converted; the rest would be cut later anyway. */
const MAX_HTML_PART_CHARS = 320_000;

/**
 * The message text: every inline text part in document order (a client can
 * put an image between two text parts). The plain version of a
 * multipart/alternative stands for its html one. When only html is left, it
 * comes back as html; when plain and html-only segments mix, the html ones are
 * converted to text in place. Never inside an attachment.
 */
export function extractBody(root: GmailMimePart | undefined): { text: string; isHtml: boolean } {
  if (!isPart(root)) return { text: "", isHtml: false };
  const attached: string[] = [];
  const alternatives: string[] = [];
  const texts: Array<{ path: string; html: boolean; data: string; part: GmailMimePart }> = [];
  for (const { part: p, path } of walkGmailMime(root)) {
    if (attached.some(parent => path.startsWith(`${parent}.`))) continue;
    if (isAttachment(p)) {
      attached.push(path);
      continue;
    }
    if (p.mimeType === "multipart/alternative") alternatives.push(path);
    const data = typeof p.body?.data === "string" ? p.body.data : null;
    if (data === null) continue;
    if (p.mimeType === "text/plain" || p.mimeType === "text/html") texts.push({ path, html: p.mimeType === "text/html", data, part: p });
  }
  const within = (path: string, alt: string) => path.startsWith(`${alt}.`);
  // An html part inside an alternative that also has a plain version is that version's twin.
  const kept = texts.filter(t => !t.html || !alternatives.some(a => within(t.path, a) && texts.some(x => !x.html && within(x.path, a))));
  if (kept.length > 0 && kept.every(t => t.html)) return { text: kept.map(t => partText(t.part, t.data)).join("\n"), isHtml: true };
  if (kept.length > 0) {
    return { text: kept.map(t => (t.html ? htmlToText(partText(t.part, t.data).slice(0, MAX_HTML_PART_CHARS)) : partText(t.part, t.data))).join("\n\n"), isHtml: false };
  }
  // A single-part message sometimes carries its data at the top with no usable type.
  if (!root.mimeType && !root.filename && typeof root.body?.data === "string") return { text: partText(root, root.body.data), isHtml: false };
  return { text: "", isHtml: false };
}

/**
 * Receipts for the message's attachments: name, type and size only. Inline
 * body parts are not attachments; a calendar invite part and a forwarded
 * message are.
 */
export function attachmentReceipts(root: GmailMimePart | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];
  const attached: string[] = [];
  for (const { part: p, path } of walkGmailMime(root)) {
    if (attached.some(parent => path.startsWith(`${parent}.`))) continue;
    const mime = (typeof p.mimeType === "string" ? p.mimeType : "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const calendar = mime === "text/calendar" || mime === "application/ics";
    if (!isAttachment(p) && !calendar) continue;
    attached.push(path);
    const size = typeof p.body?.size === "number" && Number.isSafeInteger(p.body.size) && p.body.size >= 0 ? p.body.size : 0;
    out.push({ name: (typeof p.filename === "string" && p.filename !== "" ? p.filename : "(unnamed)").slice(0, 300), mime: mime.slice(0, 120), size });
    if (out.length >= GMAIL_MIME_LIMITS.attachments) break;
  }
  return out;
}

/**
 * The iCalendar METHOD of the message's first `text/calendar` part, from its
 * Content-Type `method` parameter (RFC 6047), uppercased; null without one.
 * Only the header is read: the calendar body is never decoded.
 */
export function calendarMethod(root: GmailMimePart | undefined): string | null {
  for (const { part: p } of walkGmailMime(root)) {
    const type = partHeader(p, "Content-Type");
    const mime = (type || (typeof p.mimeType === "string" ? p.mimeType : "")).split(";")[0]!.trim().toLowerCase();
    if (mime !== "text/calendar") continue;
    const method = /;\s*method\s*=\s*"?([a-z-]{1,32})"?/i.exec(type);
    if (method) return method[1]!.toUpperCase();
  }
  return null;
}

/** Split an address header on commas outside quotes and angle brackets. Linear. */
function splitAddresses(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const c of raw) {
    if (c === "\"" && !angle) quoted = !quoted;
    else if (c === "<" && !quoted) angle = true;
    else if (c === ">" && !quoted) angle = false;
    if (c === "," && !quoted && !angle) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(s => s !== "");
}

/**
 * One address: `Name <a@b>`, `"Doe, Jane" <a@b>` or a bare `a@b`; null
 * without an address. The display name's encoded words are decoded after the
 * list was split, so a decoded comma cannot split it.
 */
export function parseAddress(raw: string): Person | null {
  const open = raw.lastIndexOf("<");
  const close = raw.indexOf(">", open + 1);
  let email: string;
  let name: string | null = null;
  if (open !== -1 && close !== -1) {
    email = raw.slice(open + 1, close).trim();
    const display = decodeEncodedWords(raw.slice(0, open).trim().replace(/^"(.*)"$/s, "$1").trim()).trim();
    name = display === "" ? null : display;
  } else {
    email = raw.trim();
  }
  if (!email.includes("@") || /\s/.test(email)) return name === null ? null : { name, email: null };
  return { name, email: email.toLowerCase() };
}

export function parseAddressList(raw: string, max = 100): Person[] {
  const out: Person[] = [];
  for (const piece of splitAddresses(raw.slice(0, GMAIL_MIME_LIMITS.headerChars))) {
    const p = parseAddress(piece);
    if (p !== null) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * RFC 3834 `Auto-Submitted`: any keyword but `no` (auto-generated,
 * auto-replied, auto-notified, extensions) is machine mail. Comments and
 * parameters are ignored; an absent header is human mail.
 */
export function isAutoSubmitted(value: string): boolean {
  // Comments dropped in one pass, so a header full of `(` stays linear.
  let bare = "";
  let depth = 0;
  for (const c of value.slice(0, GMAIL_MIME_LIMITS.headerChars)) {
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) {
      depth--;
      bare += " ";
    } else if (depth === 0) bare += c;
  }
  const keyword = bare.split(";")[0]!.trim().toLowerCase();
  return keyword !== "" && keyword !== "no";
}
