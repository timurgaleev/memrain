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
import { SPEAKER_OWNER_KEY, speakerOwnerFromTurns } from "../speaker-owner.ts";
import { guardSecrets, type SecretFinding } from "../secret-scan.ts";
import { neutralizeOutsideText } from "../neutralize-outside-text.ts";
import { OUTSIDE_NEUTRALIZED } from "../fence-carry.ts";
import { calendarLoopSignals, chatLoopSignals, mailLoopSignals, type LoopSignals } from "../loops/signals.ts";
import { FORWARD_MARKER } from "../loops/detect.ts";
import { redactMeetingCredentials } from "./meeting-redact.ts";
import {
  serviceAccountRef,
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
  /** Reply state for the loop detector; no message text (loops/signals.ts). */
  loop?: LoopSignals;
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

/**
 * One message's text past this is cut with a marker: a reply carries its own
 * words, and a body longer than this is a pasted log or a newsletter, which
 * would cost embeddings without adding much to recall.
 */
export const MAX_MAIL_MESSAGE_CHARS = 20_000;

const BULK_CATEGORIES = new Set(["promotions", "social"]);
const BULK_LOCAL_PART = /^(?:no-?reply|do-?not-?reply|mailer-daemon|notifications?|bounces?)(?:[+.-]|$)/i;
/** Machine senders matched anywhere in the local part (`billing-noreply@`, `postmaster@`); never the domain. */
const NOISE_SENDER_SUBSTRINGS = ["noreply", "no-reply", "calendar-notification", "mailer-daemon", "postmaster", "donotreply", "do-not-reply"];
/** Local parts that end like a notification mailbox (`team-notifications@`). */
const NOISE_LOCAL_SUFFIXES = ["notifications", "notification"];
/**
 * Separator and localized no-reply spellings, matched in the local part from
 * its start or after a separator, so a person whose name merely contains a
 * fragment stays a person.
 */
const NOISE_LOCAL_PART = /(?:^|[-._+])(?:no[._]reply|do[-._]not[-._]reply|no[-._]?responder|ne[-._]?pas[-._]?repondre|keine[-._]?antwort)|notifica(?:ciones|coes)$/;
/** Google system addresses that carry no human message, matched by equality. */
const SYSTEM_SENDERS: ReadonlySet<string> = new Set(["gemini-notes@google.com"]);

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
    return oneLine(this.text(value), max);
  }

  /**
   * Text that can carry an online-meeting invitation (a mail body or subject,
   * an event's description, title or place, a chat message, a meeting
   * summary): its meeting credentials go first
   * (meeting-redact.ts), then it is guarded like any outside text.
   */
  invite(value: string | null | undefined): string {
    return this.text(redactMeetingCredentials(value ?? "").text);
  }

  inviteLine(value: string | null | undefined, max = 300): string {
    return oneLine(this.invite(value), max);
  }

  person(p: Person | null | undefined): string {
    if (!p) return "unknown";
    const name = this.line(p.name);
    const email = this.line(p.email);
    if (name && email) return `${name} <${email}>`;
    return name || email || "unknown";
  }
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
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
    account: serviceAccountRef(ctx),
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

const REPLY_MARKER = /^(?:On .{4,200} wrote:|-{2,}\s*Original Message\s*-{2,})$/i;
const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
/** A mail client's own footer line, only ever cut at the end of a message. */
const CLIENT_FOOTER = /^(?:Sent from my [\w .'-]{1,40}|Sent from (?:Mail|Outlook|Yahoo Mail|Gmail)(?: for [\w .-]{1,30})?|Get Outlook for (?:iOS|Android|Mac|Windows))$/i;

/**
 * Drop quoted history, a `-- ` signature and a trailing mail-client footer
 * ("Sent from my iPhone"). A reply marker ("On ... wrote:",
 * an Outlook "Original Message" line) ends the message: what follows repeats
 * an earlier message of the thread. A forward before any reply marker keeps
 * the body whole, since forwarded text is new to the brain. Otherwise `>`
 * lines go, with the "wrote:" line before them.
 */
export function trimMailBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    const l = line.trim();
    if (FORWARD_MARKER.test(l)) return lines.join("\n").trim();
    if (REPLY_MARKER.test(l)) break;
  }
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "-- " || line === "--") break;
    if (REPLY_MARKER.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) {
      const prev = kept.at(-1);
      if (prev !== undefined && /wrote:\s*$/i.test(prev)) kept.pop();
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && (kept.at(-1)!.trim() === "" || CLIENT_FOOTER.test(kept.at(-1)!.trim()))) kept.pop();
  return kept.join("\n").trim();
}

/** One message's text, cut at MAX_MAIL_MESSAGE_CHARS with a marker. */
function messageText(m: MailMessage): string {
  // Cut long HTML before converting it: only the first part survives anyway.
  const raw = m.bodyText ?? (m.bodyHtml === null ? "" : htmlToText(m.bodyHtml.slice(0, MAX_MAIL_MESSAGE_CHARS * 16)));
  const text = trimMailBody(raw);
  return text.length > MAX_MAIL_MESSAGE_CHARS ? `${text.slice(0, MAX_MAIL_MESSAGE_CHARS)}\n[message truncated]` : text;
}

function isNoiseSender(email: string | null): boolean {
  const address = (email ?? "").trim().toLowerCase();
  if (address === "") return false;
  const local = address.replace(/@[^@]*$/, "");
  return SYSTEM_SENDERS.has(address) || NOISE_SENDER_SUBSTRINGS.some(p => local.includes(p))
    || NOISE_LOCAL_SUFFIXES.some(p => local.endsWith(p)) || NOISE_LOCAL_PART.test(local) || BULK_LOCAL_PART.test(local);
}

function isBulk(messages: readonly MailMessage[]): boolean {
  return messages.some(m => m.listUnsubscribe || m.autoSubmitted === true || m.listId === true
    || BULK_PRECEDENCE.has((m.precedence ?? "").trim().toLowerCase())
    || m.categories.some(c => BULK_CATEGORIES.has(c.toLowerCase()))
    || isNoiseSender(m.from.email));
}

export function renderMailThread(ctx: ConnectorContext, thread: MailThread): RenderedConnectorPage {
  if (thread.messages.length === 0) throw new Error("connector mail thread has no messages");
  const messages = [...thread.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const first = iso(messages[0]!.date, "message date");
  const last = iso(messages.at(-1)!.date, "message date");
  const account = serviceAccountRef(ctx);
  const slug = `mail/${account}/${first.slice(0, 7)}/${shortHash(`thread:${thread.threadId}`)}`;
  const g = new Guard(`connector mail '${slug}'`);
  const subject = headingText(g.inviteLine(messages[0]!.subject), "(no subject)");

  const lines = [`# ${subject}`, "", `Mail thread · ${messages.length} message${messages.length === 1 ? "" : "s"}`, ""];
  const bodies: string[] = [];
  messages.forEach((m, i) => {
    lines.push(`## Message ${i + 1}`, "", `From: ${g.person(m.from)}`);
    if (m.to.length) lines.push(`To: ${m.to.map(p => g.person(p)).join(", ")}`);
    if (m.cc.length) lines.push(`Cc: ${m.cc.map(p => g.person(p)).join(", ")}`);
    lines.push(`Date: ${iso(m.date, "message date")}`);
    if (m.attachments.length) {
      lines.push(`Attachments: ${m.attachments.map(a => `${g.line(a.name, 200)} (${g.line(a.mime, 100)}, ${Math.max(0, Math.trunc(a.size))} bytes)`).join("; ")}`);
    }
    const body = g.invite(messageText(m)).trim();
    bodies.push(body);
    lines.push("", body === "" ? "_No text._" : body, "");
  });

  const dedupe = messages[0]!.messageIdHeader;
  const truth = baseTruth(ctx, "mail", thread.threadId, first, last);
  truth["messages"] = messages.length;
  if (thread.labels !== undefined) {
    truth["labels"] = [...new Set(thread.labels.map(l => g.line(l, 100).toLowerCase()).filter(l => l !== ""))].sort();
  }
  if (dedupe) truth["dedupe_key"] = shortHash(`message-id:${dedupe.trim().toLowerCase()}`);
  return {
    slug, type: CONNECTOR_PAGE_TYPES.mail, title: subject, body: finish(lines), truth, findings: g.findings,
    kind: "mail", externalId: thread.threadId, occurredAt: first,
    participants: messages.flatMap(m => [m.from, ...m.to, ...m.cc]),
    bulk: isBulk(messages),
    loop: mailLoopSignals(ctx, thread.threadId, messages, bodies, subject, p => g.person(p)),
  };
}

// ---------------------------------------------------------------------------
// Calendar.

export function renderCalendarEvent(ctx: ConnectorContext, event: CalendarEvent): RenderedConnectorPage {
  const start = iso(event.start, "event start");
  const end = event.end === null ? null : iso(event.end, "event end");
  const key = shortHash(event.iCalUID ? `ical:${event.iCalUID}` : `event:${ctx.service}:${event.id}`);
  // No date in the slug: a rescheduled event stays one page.
  const slug = `calendar/${serviceAccountRef(ctx)}/${key}`;
  const g = new Guard(`connector event '${slug}'`);
  const title = headingText(g.inviteLine(event.title), "(untitled event)");

  const lines = [`# ${title}`, "", `Calendar event · ${event.status}`, "", `When: ${event.allDay ? start.slice(0, 10) : start}${end ? ` to ${event.allDay ? end.slice(0, 10) : end}` : ""}`];
  if (event.location) lines.push(`Where: ${g.inviteLine(event.location)}`);
  if (event.onlineMeeting) lines.push("Online meeting: yes");
  if (event.organizer) lines.push(`Organizer: ${g.person(event.organizer)}`);
  if (event.recurrence?.length) lines.push(`Repeats: ${event.recurrence.map(r => g.line(r, 200)).join("; ")}`);
  const occurrences = [...(event.occurrences ?? [])]
    .map(o => ({ start: iso(o.start, "occurrence start"), end: o.end === null ? null : iso(o.end, "occurrence end"), status: o.status }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (occurrences.length) {
    lines.push("", "Occurrences:");
    for (const o of occurrences) {
      const when = event.allDay ? o.start.slice(0, 10) : o.start;
      lines.push(`* ${when}${o.end ? ` to ${event.allDay ? o.end.slice(0, 10) : o.end}` : ""}${o.status === "confirmed" ? "" : ` (${o.status})`}`);
    }
    if (event.occurrencesTruncated) lines.push("_more occurrences in the window are not listed_");
  }
  if (event.attendees.length) {
    lines.push("", "Attendees:");
    for (const a of event.attendees) lines.push(`* ${g.person(a)}${a.response ? ` (${g.line(a.response, 40)})` : ""}`);
  }
  const description = event.description === null ? "" : g.invite(htmlToText(event.description)).trim();
  if (description) lines.push("", description);

  // A series that began long ago is still active while it keeps occurring:
  // its latest listed occurrence, not its first, keeps it inside retention.
  const last = occurrences.reduce((max, o) => {
    const at = o.end ?? o.start;
    return at > max ? at : max;
  }, end ?? start);
  const truth = baseTruth(ctx, "calendar", event.id, start, last);
  truth["status"] = event.status;
  if (event.iCalUID) truth["dedupe_key"] = shortHash(`ical:${event.iCalUID}`);
  return {
    slug, type: CONNECTOR_PAGE_TYPES.calendar, title, body: finish(lines), truth, findings: g.findings,
    kind: "calendar", externalId: event.id, occurredAt: start,
    participants: [...(event.organizer ? [event.organizer] : []), ...event.attendees],
    bulk: false,
    loop: calendarLoopSignals(ctx, event, start, title, p => g.person(p), occurrences.filter(o => o.status !== "cancelled").map(o => o.start)),
  };
}

// ---------------------------------------------------------------------------
// Chat.

export function renderChatDay(ctx: ConnectorContext, day: ChatDay): RenderedConnectorPage {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.day)) throw new Error("connector chat day is not YYYY-MM-DD");
  const dayStart = iso(`${day.day}T00:00:00.000Z`, "chat day");
  const messages = [...day.messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const slug = `chat/${serviceAccountRef(ctx)}/${shortHash(`channel:${day.channelId}`)}/${day.day}`;
  const g = new Guard(`connector chat '${slug}'`);
  const channel = headingText(g.line(day.channelName, 120), "channel");
  const title = `#${channel} · ${day.day}`;

  const lines = [`# ${title}`, "", `${day.private ? "Private chat" : "Chat"} channel day · ${messages.length} message${messages.length === 1 ? "" : "s"}`, ""];
  const bodies: string[] = [];
  const turns: Array<{ label: string; owner: boolean }> = [];
  for (const m of messages) {
    const at = iso(m.ts, "message time");
    // A thread reply posted on a later day stays with its thread and carries its own date.
    const stamp = at.slice(0, 10) === day.day ? at.slice(11, 16) : `${at.slice(0, 10)} ${at.slice(11, 16)}`;
    const speaker = g.person({ name: m.author.name, email: m.author.name ? null : m.author.email });
    turns.push({ label: speaker, owner: m.fromSelf === true });
    lines.push(`${stamp} ${speaker}${m.threadId ? " (reply)" : ""}`);
    const text = g.invite(m.text).trim();
    bodies.push(text);
    lines.push(text === "" ? "_No text._" : text, "");
  }
  if (day.truncated) lines.push("_Only part of this day is stored: a listing held more than 5,000 messages._", "");
  const loop = chatLoopSignals(day, bodies, channel, p => g.person(p));
  const lastActivity = messages.length ? iso(messages.at(-1)!.ts, "message time") : dayStart;
  const truth = baseTruth(ctx, "chat", `${day.channelId}:${day.day}`, dayStart, lastActivity);
  truth["messages"] = messages.length;
  if (day.private) truth["private"] = true;
  if (day.truncated) truth["truncated"] = true;
  // Which speaker is the account's own, only when the provider marked every message.
  const owner = messages.every((m) => m.fromSelf !== undefined) ? speakerOwnerFromTurns(turns, "is_from_me", null) : null;
  if (owner) truth[SPEAKER_OWNER_KEY] = owner;
  return {
    slug, type: CONNECTOR_PAGE_TYPES.chat, title, body: finish(lines), truth, findings: g.findings,
    kind: "chat", externalId: `${day.channelId}:${day.day}`, occurredAt: dayStart,
    participants: messages.map(m => m.author),
    bulk: false,
    ...(loop ? { loop } : {}),
  };
}

// ---------------------------------------------------------------------------
// Meetings.

export function renderMeeting(ctx: ConnectorContext, meeting: MeetingTranscript): RenderedConnectorPage {
  const start = iso(meeting.start, "meeting start");
  const end = meeting.end === null ? null : iso(meeting.end, "meeting end");
  const slug = `meeting/${serviceAccountRef(ctx)}/${start.slice(0, 10)}-${shortHash(`meeting:${ctx.service}:${meeting.id}`)}`;
  const g = new Guard(`connector meeting '${slug}'`);
  const title = headingText(g.inviteLine(meeting.title), "(untitled meeting)");

  const lines = [`# ${title}`, "", `Meeting · ${start}${end ? ` to ${end}` : ""}`, ""];
  if (meeting.participants.length) lines.push(`Participants: ${meeting.participants.map(p => g.person(p)).join(", ")}`, "");
  const summary = g.invite(meeting.summary).trim();
  if (summary) lines.push("## Summary", "", summary, "");
  if (meeting.actionItems.length) {
    lines.push("## Action items", "");
    for (const item of meeting.actionItems) lines.push(`- ${g.inviteLine(item, 1000)}`);
    lines.push("");
  }
  if (meeting.sentences.length) {
    lines.push("## Transcript", "");
    let bytes = 0;
    for (const [i, s] of meeting.sentences.entries()) {
      const row = `${g.inviteLine(s.speaker, 120) || "Speaker"}: ${g.inviteLine(s.text, 4000)}`;
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
