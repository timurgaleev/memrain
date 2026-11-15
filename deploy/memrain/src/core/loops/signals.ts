/**
 * The reply state of one connector item, read off the provider's own fields
 * when the item is rendered: who sent each message, whether the account was in
 * To, whether the message is list mail, an auto-reply or a calendar notice, and
 * whether its text asks a question, makes a promise or only says thanks.
 *
 * This is what the loop detector (detect.ts) judges, and what loop_threads
 * stores. No message body is kept: only flags, times, and the name and address
 * hash of the people a loop can be about. Labels are outside text; readers
 * frame them as such.
 *
 * Deterministic and free: no model, no network.
 */
import { createHash } from "node:crypto";
import type { CalendarEvent, ChatDay, ConnectorContext, MailMessage, Person } from "../connectors/model.ts";
import { asksQuestion, isAcknowledgementOnly, makesPromise } from "./detect.ts";

export const LOOP_SIGNALS_VERSION = 1;

export interface MessageSignal {
  /** ISO-8601 send time. */
  at: string;
  /** The connected account sent it. */
  mine: boolean;
  /** The account was a To recipient (mail), or the conversation is direct (chat). */
  toMe: boolean;
  /** Sender as shown (outside text). */
  from: string;
  /** Hash of the sender's address (or chat name): what a sender mute matches. */
  fromKey: string;
  /** On a message of mine: the first other To recipient, whom an ask or promise is to. */
  to?: string;
  toKey?: string;
  question: boolean;
  ack: boolean;
  promise: boolean;
  /** Machine mail (no-reply sender, auto-reply, calendar notice, bot): neither opens nor closes a loop. */
  machine: boolean;
  /** List or bulk mail by its own headers: owes no reply. */
  bulk: boolean;
  /** Filed under a bulk category (promotions, social, forums) by the provider. */
  category: boolean;
}

export interface ThreadLoopSignals {
  v: number;
  kind: "mail" | "chat";
  threadRef: string;
  title: string;
  messages: MessageSignal[];
}

export interface CalendarLoopSignals {
  v: number;
  kind: "calendar";
  threadRef: string;
  title: string;
  start: string;
  status: CalendarEvent["status"];
  organizerMine: boolean;
  organizer: string | null;
  organizerKey: string | null;
  /** The account's own attendee response, lowercased; null when it is not an attendee. */
  myResponse: string | null;
}

export type LoopSignals = ThreadLoopSignals | CalendarLoopSignals;

const REF_LEN = 16;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, REF_LEN);

/** The hash a sender mute and `open_loops.counterparty_key` use for an address. */
export function counterpartyKey(address: string): string {
  return hash(`counterparty:${address.trim().toLowerCase()}`);
}

/** Same as the slug segment the renderer derives, so a thread ref never carries an id. */
export function threadRefOf(kind: "mail" | "chat" | "calendar", id: string): string {
  return kind === "calendar" ? hash(id) : hash(`${kind === "mail" ? "thread" : "channel"}:${id}`);
}

const NOISE_SENDER_SUBSTRINGS = [
  "noreply", "no-reply", "notifications@", "notification@", "calendar-notification",
  "mailer-daemon", "postmaster", "donotreply", "do-not-reply",
];
/** Separator and localized no-reply spellings, matched in the local part only. */
const NOISE_LOCAL_PART = /(?:^|[-._+])(?:no[._]reply|do[-._]not[-._]reply|no[-._]?responder|ne[-._]?pas[-._]?repondre|keine[-._]?antwort)|notifica(?:ciones|coes)$/;

export function isNoiseSender(address: string): boolean {
  const a = address.toLowerCase();
  return NOISE_SENDER_SUBSTRINGS.some(p => a.includes(p)) || NOISE_LOCAL_PART.test(a.replace(/@[^@]*$/, ""));
}

/** iCalendar METHOD values (RFC 5546) Calendar stamps on its notices; '' and unknown values are not trusted. */
const CALENDAR_METHODS = new Set(["REQUEST", "REPLY", "CANCEL", "PUBLISH", "COUNTER", "DECLINECOUNTER", "REFRESH", "ADD"]);
/** Calendar's own localized notice headers, anchored at the start of the subject. */
const CALENDAR_SUBJECT_PREFIXES = [
  "invitation:", "updated invitation:", "invitation with note:", "updated invitation with note:",
  "accepted:", "declined:", "tentative:", "canceled event:", "cancelled event:",
  "приглашение:", "обновлённое приглашение:", "обновленное приглашение:",
  "принято:", "отклонено:", "под вопросом:", "отменено:", "отмена мероприятия:",
  "invitación:", "invitación actualizada:", "aceptada:", "rechazada:",
  "invitation mise à jour:", "acceptée:", "refusée:",
  "einladung:", "aktualisierte einladung:", "zugesagt:", "abgesagt:",
];
const REPLY_OR_FORWARD_PREFIX = /^\s*(?:(?:re|fwd?|aw|sv|vs)\s*:\s*)+/i;

/**
 * Calendar's invitation, response and cancellation notices. They come from the
 * colleague's real address, so no sender rule could catch them without also
 * silencing that person. A Re:/Fwd: subject is a human and never matches.
 */
export function isCalendarNotice(calendarMethod: string | null | undefined, subject: string): boolean {
  if (calendarMethod && CALENDAR_METHODS.has(calendarMethod.trim().toUpperCase())) return true;
  if (REPLY_OR_FORWARD_PREFIX.test(subject)) return false;
  const lowered = subject.trim().toLowerCase();
  return CALENDAR_SUBJECT_PREFIXES.some(p => lowered.startsWith(p));
}

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
const BULK_CATEGORIES = new Set(["promotions", "social", "forums"]);

/** Mail that declares itself automated by its headers; a category alone is not such a declaration. */
function isDeclaredBulk(m: MailMessage): boolean {
  return m.listUnsubscribe || m.listId === true || BULK_PRECEDENCE.has((m.precedence ?? "").trim().toLowerCase())
    || (m.replyTo ?? []).some(a => isNoiseSender(a));
}

export function stripReplyPrefix(subject: string): string {
  return subject.replace(REPLY_OR_FORWARD_PREFIX, "").trim() || subject.trim();
}

const lower = (p: Person) => (p.email ?? "").trim().toLowerCase();

/**
 * Signals of a mail thread. `bodies[i]` is message i's text as the page shows
 * it (quoted history and signature already trimmed), `label` renders a person
 * the way the page does, and `title` is the page's subject line.
 */
export function mailLoopSignals(
  ctx: ConnectorContext,
  threadId: string,
  messages: readonly MailMessage[],
  bodies: readonly string[],
  title: string,
  label: (p: Person) => string,
): ThreadLoopSignals {
  const own = new Set([ctx.accountLabel.trim().toLowerCase()]);
  return {
    v: LOOP_SIGNALS_VERSION,
    kind: "mail",
    threadRef: threadRefOf("mail", threadId),
    title: stripReplyPrefix(title),
    messages: messages.map((m, i) => {
      const from = lower(m.from);
      const isMine = m.sent === true || own.has(from);
      const body = bodies[i] ?? "";
      const to = isMine ? m.to.find(p => lower(p) !== "" && !own.has(lower(p))) : undefined;
      return {
        at: new Date(Date.parse(m.date)).toISOString(),
        mine: isMine,
        toMe: m.to.some(p => own.has(lower(p))),
        from: label(m.from),
        fromKey: counterpartyKey(from || label(m.from)),
        ...(to ? { to: label(to), toKey: counterpartyKey(lower(to)) } : {}),
        question: asksQuestion(body),
        ack: isAcknowledgementOnly(body),
        promise: isMine && makesPromise(body),
        machine: (!isMine && isNoiseSender(from)) || m.autoSubmitted === true || isCalendarNotice(m.calendarMethod, m.subject),
        bulk: isDeclaredBulk(m),
        category: m.categories.some(c => BULK_CATEGORIES.has(c.toLowerCase())),
      };
    }),
  };
}

/**
 * Signals of one day of a direct conversation. Only a day the adapter marked
 * direct, with each message's author marked as the account or not, has any:
 * in a channel nobody is waiting on the account in particular, and without
 * the author marks direction cannot be told.
 */
export function chatLoopSignals(
  day: ChatDay,
  bodies: readonly string[],
  title: string,
  label: (p: Person) => string,
): ThreadLoopSignals | undefined {
  if (day.direct !== true || day.messages.some(m => m.fromSelf === undefined)) return undefined;
  const sorted = [...day.messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const other = sorted.find(m => !m.fromSelf);
  const otherLabel = other ? label({ name: other.author.name, email: other.author.name ? null : other.author.email }) : undefined;
  const keyOf = (p: Person) => counterpartyKey(lower(p) || `name:${(p.name ?? "").trim().toLowerCase()}`);
  return {
    v: LOOP_SIGNALS_VERSION,
    kind: "chat",
    threadRef: threadRefOf("chat", day.channelId),
    title,
    messages: sorted.map((m, i) => {
      const body = bodies[i] ?? "";
      const isMine = m.fromSelf === true;
      return {
        at: new Date(Date.parse(m.ts)).toISOString(),
        mine: isMine,
        toMe: true,
        from: label({ name: m.author.name, email: m.author.name ? null : m.author.email }),
        fromKey: keyOf(m.author),
        ...(isMine && other && otherLabel ? { to: otherLabel, toKey: keyOf(other.author) } : {}),
        question: asksQuestion(body),
        ack: isAcknowledgementOnly(body),
        promise: isMine && makesPromise(body),
        machine: m.bot === true,
        bulk: false,
        category: false,
      };
    }),
  };
}

/** Several day pages of one conversation as one thread, messages in time order. */
export function mergeThreadSignals(parts: readonly ThreadLoopSignals[]): ThreadLoopSignals {
  if (parts.length === 0) throw new Error("mergeThreadSignals: no parts");
  const latest = parts.reduce((a, b) => (lastAt(b) > lastAt(a) ? b : a));
  const messages = parts.flatMap(p => p.messages).sort((a, b) => a.at.localeCompare(b.at));
  return { ...latest, messages };
}

function lastAt(s: ThreadLoopSignals): string {
  return s.messages.at(-1)?.at ?? "";
}

/** Signals of a calendar event: only the account's own response and who organised it. */
export function calendarLoopSignals(
  ctx: ConnectorContext,
  event: CalendarEvent,
  start: string,
  title: string,
  label: (p: Person) => string,
): CalendarLoopSignals {
  const own = ctx.accountLabel.trim().toLowerCase();
  const me = event.attendees.find(a => lower(a) === own);
  const organizer = event.organizer;
  return {
    v: LOOP_SIGNALS_VERSION,
    kind: "calendar",
    threadRef: threadRefOf("calendar", event.iCalUID ? `ical:${event.iCalUID}` : `event:${ctx.service}:${event.id}`),
    title,
    start,
    status: event.status,
    organizerMine: organizer !== null && lower(organizer) === own,
    organizer: organizer ? label(organizer) : null,
    organizerKey: organizer && lower(organizer) ? counterpartyKey(lower(organizer)) : null,
    myResponse: me ? (me.response ?? "needsaction").toLowerCase() : null,
  };
}

/** When the item last changed hands: the last message, or the event's start. */
export function signalsActivityAt(s: LoopSignals): string {
  return s.kind === "calendar" ? s.start : (s.messages.at(-1)?.at ?? new Date(0).toISOString());
}

/** Shape check for signals read back from the database. */
export function isLoopSignals(value: unknown): value is LoopSignals {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["v"] !== LOOP_SIGNALS_VERSION || typeof v["threadRef"] !== "string" || typeof v["title"] !== "string") return false;
  if (v["kind"] === "calendar") return typeof v["start"] === "string" && typeof v["status"] === "string";
  return (v["kind"] === "mail" || v["kind"] === "chat") && Array.isArray(v["messages"]);
}
