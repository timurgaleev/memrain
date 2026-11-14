/**
 * Render normalized connector items (model.ts) as brain pages. Pure.
 *
 * One renderer per data kind, shared by every provider of that kind. Each page
 * is outside text: its compiled truth says `origin: connector` and
 * `trust: untrusted`, every outside field is secret-scanned (a credential under
 * `reject` refuses the item whole) and neutralized so it cannot pass for a
 * fence, a citation or a timeline row, and readers frame it by its source kind
 * (trust-frame.ts). Gate-owned keys never come from outside input: the truth is
 * built here from named fields only, and the page is mirrored as untrusted.
 *
 * Slugs carry hashes, never addresses, names or subjects, so a slug can sit in
 * a receipt or a log line without leaking message text.
 */
import { guardSecrets, type SecretFinding } from "../secret-scan.ts";
import { neutralizeOutsideText } from "../neutralize-outside-text.ts";
import { OUTSIDE_NEUTRALIZED } from "../fence-carry.ts";
import {
  accountRef,
  shortHash,
  type CalendarEvent,
  type ChatDay,
  type ConnectorContext,
  type ConnectorDataKind,
  type MailMessage,
  type MailThread,
  type MeetingTranscript,
  type Person,
} from "./model.ts";

export interface RenderedConnectorPage {
  slug: string;
  type: string;
  title: string;
  body: string;
  truth: Record<string, unknown>;
  findings: SecretFinding[];
  kind: ConnectorDataKind;
  externalId: string;
  /** When the item happened: first message, event start, chat day, meeting start. */
  occurredAt: string;
  /** Everyone named on the item, for deterministic enrichment. */
  participants: Person[];
  /** Mailing-list or notification mail: enrichment links nobody from it. */
  bulk: boolean;
}

export const CONNECTOR_PAGE_TYPES: Readonly<Record<ConnectorDataKind, string>> = {
  mail: "connector-mail",
  calendar: "connector-calendar",
  chat: "connector-chat",
  meeting: "connector-meeting",
};

/**
 * A transcript is rendered whole; the sync engine splits a long one into part
 * pages (splitLargeDocument), so nothing is lost to a page size limit. Past this
 * ceiling a provider is sending something no meeting produces, and the rest is
 * cut with a marker saying so.
 */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

const BULK_CATEGORIES = new Set(["promotions", "social"]);
const BULK_LOCAL_PART = /^(?:no-?reply|do-?not-?reply|mailer-daemon|notifications?|bounces?)(?:[+.-]|$)/i;

// ---------------------------------------------------------------------------
// HTML to text: indexOf scans only, so hostile markup stays linear.

const DROPPED_BLOCKS = ["script", "style", "head", "noscript", "template"];
const BREAK_TAGS = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"]);
const HTML_TAGS = new Set([
  ...BREAK_TAGS, "html", "body", "span", "a", "b", "i", "u", "s", "em", "strong", "small", "big", "sub", "sup", "font",
  "ul", "ol", "dl", "dt", "dd", "td", "th", "thead", "tbody", "tfoot", "col", "colgroup", "caption", "center",
  "img", "hr", "pre", "code", "blockquote", "section", "article", "header", "footer", "nav", "main", "meta", "link",
  "title", "label", "button", "input", "form", "select", "option", "textarea", "wbr", "abbr", "cite", "q", "mark",
  "del", "ins", "figure", "figcaption", "picture", "source", "svg", "path", "style", "script", "head", "noscript", "template",
]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** ASCII-only lowercase, so every index into it is an index into the original. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** A tag name ends at whitespace, `>` or `/`: `<scripture>` is not `<script`. */
function endsTagName(text: string, at: number): boolean {
  const c = text[at];
  return c === undefined || c === ">" || c === "/" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/** Next `<tag` at or after `from` whose name ends there, or -1. */
function findOpen(lower: string, tag: string, from: number): number {
  let at = lower.indexOf(`<${tag}`, from);
  while (at !== -1 && !endsTagName(lower, at + tag.length + 1)) at = lower.indexOf(`<${tag}`, at + 1);
  return at;
}

function dropBlocks(html: string): string {
  const lower = asciiLower(html);
  // Each tag's next opening, recomputed only once the scan has passed it, so
  // the whole pass stays linear however the blocks interleave.
  const next = new Map(DROPPED_BLOCKS.map(t => [t, findOpen(lower, t, 0)]));
  let out = "";
  let from = 0;
  for (;;) {
    let at = -1;
    let tag = "";
    for (const t of DROPPED_BLOCKS) {
      let pos = next.get(t)!;
      if (pos !== -1 && pos < from) {
        pos = findOpen(lower, t, from);
        next.set(t, pos);
      }
      if (pos !== -1 && (at === -1 || pos < at)) {
        at = pos;
        tag = t;
      }
    }
    if (at === -1) break;
    out += html.slice(from, at);
    const close = lower.indexOf(`</${tag}`, at);
    if (close === -1) return out;
    const end = lower.indexOf(">", close);
    from = end === -1 ? html.length : end + 1;
  }
  return out + html.slice(from);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  const body = dropBlocks(html);
  let out = "";
  let from = 0;
  while (from < body.length) {
    const open = body.indexOf("<", from);
    if (open === -1) break;
    out += body.slice(from, open);
    const close = body.indexOf(">", open);
    // Only a known HTML element, a namespaced Office tag or a comment is markup;
    // `Budget < $5k`, `<baseline>` and `<https://...>` in plain text stay text.
    const head = /^<(!|\/?\s*([a-z][a-z0-9]*)(:[a-z])?)/i.exec(body.slice(open, Math.min(close === -1 ? body.length : close + 1, open + 40)));
    const name = head?.[2]?.toLowerCase();
    if (close === -1 || !head || (head[1] !== "!" && !HTML_TAGS.has(name!) && head[3] === undefined)) {
      out += "<";
      from = open + 1;
      continue;
    }
    if (name !== undefined && BREAK_TAGS.has(name)) out += "\n";
    from = close + 1;
  }
  out += body.slice(from);
  return decodeEntities(out)
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Shared helpers.

class Guard {
  readonly findings: SecretFinding[] = [];
  constructor(private readonly where: string) {}

  /** Outside multi-line text: scanned, then neutralized. */
  text(value: string | null | undefined): string {
    const r = guardSecrets(value ?? "", this.where);
    this.findings.push(...r.findings);
    return neutralizeOutsideText(r.text);
  }

  /** Outside single-line text (a name, a subject, an address). */
  line(value: string | null | undefined, max = 300): string {
    return this.text(value).replace(/\s+/g, " ").trim().slice(0, max);
  }

  person(p: Person | null | undefined): string {
    if (!p) return "unknown";
    const name = this.line(p.name);
    const email = this.line(p.email);
    if (name && email) return `${name} <${email}>`;
    return name || email || "unknown";
  }
}

function iso(value: string, what: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`connector item has an invalid ${what}`);
  return new Date(t).toISOString();
}

function baseTruth(ctx: ConnectorContext, kind: ConnectorDataKind, externalId: string, occurredAt: string, lastActivityAt: string): Record<string, unknown> {
  return {
    origin: "connector",
    connector: ctx.service,
    kind,
    trust: "untrusted",
    account: accountRef(ctx.accountLabel),
    external_id: externalId,
    occurred_at: occurredAt,
    last_activity_at: lastActivityAt,
    [OUTSIDE_NEUTRALIZED]: 1,
  };
}

function headingText(raw: string, fallback: string): string {
  const t = raw.trim();
  return t === "" ? fallback : t;
}

/** The composed page is neutralized once more, so an outside value placed at the
 *  start of a heading or bullet cannot complete a timeline line either. */
function finish(lines: string[]): string {
  return `${neutralizeOutsideText(lines.join("\n")).replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// ---------------------------------------------------------------------------
// Mail.

/** Drop quoted history (`>` lines and the "On ... wrote:" line before them) and a `-- ` signature. */
export function trimMailBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "-- " || line === "--") break;
    if (line.trimStart().startsWith(">")) {
      const prev = kept.at(-1);
      if (prev !== undefined && /wrote:\s*$/i.test(prev)) kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function isBulk(messages: readonly MailMessage[]): boolean {
  return messages.some(m => m.listUnsubscribe
    || m.categories.some(c => BULK_CATEGORIES.has(c.toLowerCase()))
    || BULK_LOCAL_PART.test((m.from.email ?? "").split("@")[0] ?? ""));
}

export function renderMailThread(ctx: ConnectorContext, thread: MailThread): RenderedConnectorPage {
  if (thread.messages.length === 0) throw new Error("connector mail thread has no messages");
  const messages = [...thread.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const first = iso(messages[0]!.date, "message date");
  const last = iso(messages.at(-1)!.date, "message date");
  const account = accountRef(ctx.accountLabel);
  const slug = `mail/${account}/${first.slice(0, 7)}/${shortHash(`thread:${thread.threadId}`)}`;
  const g = new Guard(`connector mail '${slug}'`);
  const subject = headingText(g.line(messages[0]!.subject), "(no subject)");

  const lines = [`# ${subject}`, "", `Mail thread · ${messages.length} message${messages.length === 1 ? "" : "s"}`, ""];
  messages.forEach((m, i) => {
    lines.push(`## Message ${i + 1}`, "", `From: ${g.person(m.from)}`);
    if (m.to.length) lines.push(`To: ${m.to.map(p => g.person(p)).join(", ")}`);
    if (m.cc.length) lines.push(`Cc: ${m.cc.map(p => g.person(p)).join(", ")}`);
    lines.push(`Date: ${iso(m.date, "message date")}`);
    if (m.attachments.length) {
      lines.push(`Attachments: ${m.attachments.map(a => `${g.line(a.name, 200)} (${g.line(a.mime, 100)}, ${Math.max(0, Math.trunc(a.size))} bytes)`).join("; ")}`);
    }
    const raw = m.bodyText ?? (m.bodyHtml === null ? "" : htmlToText(m.bodyHtml));
    const body = g.text(trimMailBody(raw)).trim();
    lines.push("", body === "" ? "_No text._" : body, "");
  });

  const dedupe = messages[0]!.messageIdHeader;
  const truth = baseTruth(ctx, "mail", thread.threadId, first, last);
  truth["messages"] = messages.length;
  if (dedupe) truth["dedupe_key"] = shortHash(`message-id:${dedupe.trim().toLowerCase()}`);
  return {
    slug, type: CONNECTOR_PAGE_TYPES.mail, title: subject, body: finish(lines), truth, findings: g.findings,
    kind: "mail", externalId: thread.threadId, occurredAt: first,
    participants: messages.flatMap(m => [m.from, ...m.to, ...m.cc]),
    bulk: isBulk(messages),
  };
}

// ---------------------------------------------------------------------------
// Calendar.

export function renderCalendarEvent(ctx: ConnectorContext, event: CalendarEvent): RenderedConnectorPage {
  const start = iso(event.start, "event start");
  const end = event.end === null ? null : iso(event.end, "event end");
  const key = shortHash(event.iCalUID ? `ical:${event.iCalUID}` : `event:${ctx.service}:${event.id}`);
  // No date in the slug: a rescheduled event stays one page.
  const slug = `calendar/${accountRef(ctx.accountLabel)}/${key}`;
  const g = new Guard(`connector event '${slug}'`);
  const title = headingText(g.line(event.title), "(untitled event)");

  const lines = [`# ${title}`, "", `Calendar event · ${event.status}`, "", `When: ${event.allDay ? start.slice(0, 10) : start}${end ? ` to ${event.allDay ? end.slice(0, 10) : end}` : ""}`];
  if (event.location) lines.push(`Where: ${g.line(event.location)}`);
  if (event.organizer) lines.push(`Organizer: ${g.person(event.organizer)}`);
  if (event.recurrence?.length) lines.push(`Repeats: ${event.recurrence.map(r => g.line(r, 200)).join("; ")}`);
  if (event.attendees.length) {
    lines.push("", "Attendees:");
    for (const a of event.attendees) lines.push(`* ${g.person(a)}${a.response ? ` (${g.line(a.response, 40)})` : ""}`);
  }
  const description = event.description === null ? "" : g.text(htmlToText(event.description)).trim();
  if (description) lines.push("", description);

  const truth = baseTruth(ctx, "calendar", event.id, start, end ?? start);
  truth["status"] = event.status;
  if (event.iCalUID) truth["dedupe_key"] = shortHash(`ical:${event.iCalUID}`);
  return {
    slug, type: CONNECTOR_PAGE_TYPES.calendar, title, body: finish(lines), truth, findings: g.findings,
    kind: "calendar", externalId: event.id, occurredAt: start,
    participants: [...(event.organizer ? [event.organizer] : []), ...event.attendees],
    bulk: false,
  };
}

// ---------------------------------------------------------------------------
// Chat.

export function renderChatDay(ctx: ConnectorContext, day: ChatDay): RenderedConnectorPage {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.day)) throw new Error("connector chat day is not YYYY-MM-DD");
  const dayStart = iso(`${day.day}T00:00:00.000Z`, "chat day");
  const messages = [...day.messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const slug = `chat/${accountRef(ctx.accountLabel)}/${shortHash(`channel:${day.channelId}`)}/${day.day}`;
  const g = new Guard(`connector chat '${slug}'`);
  const channel = headingText(g.line(day.channelName, 120), "channel");
  const title = `#${channel} · ${day.day}`;

  const lines = [`# ${title}`, "", `Chat channel day · ${messages.length} message${messages.length === 1 ? "" : "s"}`, ""];
  for (const m of messages) {
    const at = iso(m.ts, "message time");
    lines.push(`${at.slice(11, 16)} ${g.person({ name: m.author.name, email: m.author.name ? null : m.author.email })}${m.threadId ? " (reply)" : ""}`);
    const text = g.text(m.text).trim();
    lines.push(text === "" ? "_No text._" : text, "");
  }
  const lastActivity = messages.length ? iso(messages.at(-1)!.ts, "message time") : dayStart;
  const truth = baseTruth(ctx, "chat", `${day.channelId}:${day.day}`, dayStart, lastActivity);
  truth["messages"] = messages.length;
  return {
    slug, type: CONNECTOR_PAGE_TYPES.chat, title, body: finish(lines), truth, findings: g.findings,
    kind: "chat", externalId: `${day.channelId}:${day.day}`, occurredAt: dayStart,
    participants: messages.map(m => m.author),
    bulk: false,
  };
}

// ---------------------------------------------------------------------------
// Meetings.

export function renderMeeting(ctx: ConnectorContext, meeting: MeetingTranscript): RenderedConnectorPage {
  const start = iso(meeting.start, "meeting start");
  const end = meeting.end === null ? null : iso(meeting.end, "meeting end");
  const slug = `meeting/${accountRef(ctx.accountLabel)}/${start.slice(0, 10)}-${shortHash(`meeting:${ctx.service}:${meeting.id}`)}`;
  const g = new Guard(`connector meeting '${slug}'`);
  const title = headingText(g.line(meeting.title), "(untitled meeting)");

  const lines = [`# ${title}`, "", `Meeting · ${start}${end ? ` to ${end}` : ""}`, ""];
  if (meeting.participants.length) lines.push(`Participants: ${meeting.participants.map(p => g.person(p)).join(", ")}`, "");
  const summary = g.text(meeting.summary).trim();
  if (summary) lines.push("## Summary", "", summary, "");
  if (meeting.actionItems.length) {
    lines.push("## Action items", "");
    for (const item of meeting.actionItems) lines.push(`- ${g.line(item, 1000)}`);
    lines.push("");
  }
  if (meeting.sentences.length) {
    lines.push("## Transcript", "");
    let bytes = 0;
    for (const [i, s] of meeting.sentences.entries()) {
      const row = `${g.line(s.speaker, 120) || "Speaker"}: ${g.line(s.text, 4000)}`;
      bytes += Buffer.byteLength(row) + 1;
      if (bytes > MAX_TRANSCRIPT_BYTES) {
        lines.push("", `_transcript truncated: ${meeting.sentences.length - i} more line(s) not stored_`);
        break;
      }
      lines.push(row);
    }
  }
  const truth = baseTruth(ctx, "meeting", meeting.id, start, end ?? start);
  return {
    slug, type: CONNECTOR_PAGE_TYPES.meeting, title, body: finish(lines), truth, findings: g.findings,
    kind: "meeting", externalId: meeting.id, occurredAt: start,
    participants: meeting.participants,
    bulk: false,
  };
}
