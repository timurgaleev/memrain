/**
 * The provider-neutral shapes connector adapters normalize into. Gmail and
 * Outlook both produce a MailThread, Google and Outlook calendars a
 * CalendarEvent, Slack and Teams chats a ChatDay, Fireflies and Teams
 * transcripts a MeetingTranscript; one renderer per kind (render.ts) turns
 * each into a page, so dedup, trust framing and deletion behave the same
 * whichever provider the item came from.
 *
 * Everything inside these shapes is outside text written by whoever can send
 * mail, invite to a meeting or post in a channel. It is data, never an
 * instruction, and nothing here is ever acted on.
 */
import { createHash } from "node:crypto";

export type ConnectorService =
  | "gmail"
  | "outlook_mail"
  | "google_calendar"
  | "outlook_calendar"
  | "slack"
  | "teams_chat"
  | "fireflies"
  | "teams_transcripts";

export type ConnectorDataKind = "mail" | "calendar" | "chat" | "meeting";

export const CONNECTOR_KINDS: readonly ConnectorDataKind[] = ["mail", "calendar", "chat", "meeting"];

/** The `sources.kind` a connector of each data kind writes into. */
export const SOURCE_KIND_FOR: Readonly<Record<ConnectorDataKind, string>> = {
  mail: "mailbox",
  calendar: "calendar",
  chat: "chat",
  meeting: "meeting",
};

export interface Person {
  name: string | null;
  email: string | null;
}

export interface MailAttachment {
  name: string;
  mime: string;
  size: number;
}

export interface MailMessage {
  id: string;
  /** RFC 5322 Message-ID, the cross-provider dedup key. */
  messageIdHeader: string | null;
  subject: string;
  from: Person;
  to: Person[];
  cc: Person[];
  /** ISO-8601. */
  date: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Receipts only: the file itself is never fetched or stored. */
  attachments: MailAttachment[];
  /** The message carried a List-Unsubscribe header. */
  listUnsubscribe: boolean;
  /** Provider categories or labels, lowercased (promotions, social, ...). */
  categories: string[];
  /*
   * Reply-state fields the loop detector reads (loops/signals.ts). Optional:
   * an adapter that cannot see one leaves it out and the rule it feeds is off.
   */
  /** The account sent this message (Gmail's SENT label, a sent-items folder), whatever address it used. */
  sent?: boolean;
  /** RFC 3834 Auto-Submitted with a value other than "no" (auto-replies, tracker notices). */
  autoSubmitted?: boolean;
  /** The Precedence header, lowercased (bulk, list, junk). */
  precedence?: string | null;
  /** The message carried a List-Id header (RFC 2919). */
  listId?: boolean;
  /** Reply-To addresses, lowercased. */
  replyTo?: string[];
  /** The iCalendar METHOD of a text/calendar part (REQUEST, REPLY, CANCEL, ...). */
  calendarMethod?: string | null;
}

export interface MailThread {
  threadId: string;
  messages: MailMessage[];
  /** The provider's labels on the thread, as it names them; recorded in the page's truth. */
  labels?: string[];
}

export interface CalendarAttendee extends Person {
  response?: string | null;
}

export interface CalendarEvent {
  id: string;
  /** iCalendar UID, shared by every provider that sees the same event. */
  iCalUID: string | null;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  organizer: Person | null;
  attendees: CalendarAttendee[];
  /** RRULE / EXRULE lines of a recurring series, rendered as given. */
  recurrence: string[] | null;
  /**
   * A series' occurrences inside the window the adapter asked for (never the
   * whole, possibly endless, series), as the provider expanded them.
   */
  occurrences?: CalendarOccurrence[];
  /** More occurrences fell inside the window than were listed. */
  occurrencesTruncated?: boolean;
}

export interface CalendarOccurrence {
  start: string;
  end: string | null;
  status: "confirmed" | "tentative" | "cancelled";
}

export interface ChatMessage {
  id: string;
  author: Person;
  ts: string;
  text: string;
  /** The parent message id when this is a thread reply. */
  threadId: string | null;
  /** Written by the connected account itself; needed, with ChatDay.direct, for reply loops. */
  fromSelf?: boolean;
  /** Posted by a bot or an integration. */
  bot?: boolean;
}

export interface ChatDay {
  workspace: string;
  channelId: string;
  channelName: string;
  /** YYYY-MM-DD in UTC. */
  day: string;
  messages: ChatMessage[];
  /** A direct conversation (a 1:1 or group DM), not a channel. */
  direct?: boolean;
}

export interface MeetingSentence {
  speaker: string;
  text: string;
}

export interface MeetingTranscript {
  id: string;
  title: string;
  start: string;
  end: string | null;
  participants: Person[];
  summary: string | null;
  actionItems: string[];
  sentences: MeetingSentence[];
}

export interface ConnectorContext {
  service: ConnectorService;
  /** The connected account's own identity (email or workspace). Hashed before it reaches a page. */
  accountLabel: string;
}

const REF_LEN = 16;

export function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, REF_LEN);
}

/**
 * The account as it appears in slugs and compiled truth: a hash of the
 * lowercased label, so no address reaches a slug, a receipt or a log line.
 */
export function accountRef(accountLabel: string): string {
  return shortHash(`account:${accountLabel.trim().toLowerCase()}`);
}
