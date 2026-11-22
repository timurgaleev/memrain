/**
 * The precision gate for the open-loop detector: a labelled corpus of threads,
 * each rendered through the real connector renderer (which reads the reply
 * state off the provider's fields) and judged by the pure detector.
 *
 * Every row asserts the exact verdict: no loop, or exactly the expected loop
 * types with the expected counterparty. A new false-positive class gets a row
 * here before its fix. Synthetic data only; the clock is frozen.
 */
import { describe, expect, test } from "bun:test";
import { renderCalendarEvent, renderChatDay, renderMailThread } from "../src/core/connectors/render.ts";
import type { CalendarEvent, ChatDay, ChatMessage, ConnectorContext, MailMessage } from "../src/core/connectors/model.ts";
import {
  asksQuestion,
  detectCalendar,
  detectThread,
  isAcknowledgementOnly,
  makesPromise,
  type LoopSuppressions,
  type ThreadVerdict,
} from "../src/core/loops/detect.ts";
import { counterpartyKey, mergeThreadSignals, type CalendarLoopSignals, type ThreadLoopSignals } from "../src/core/loops/signals.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const ME = "me@example.com";
const MAIL: ConnectorContext = { service: "gmail", accountLabel: ME };
const H = 3_600_000;

let seq = 0;

interface MsgSpec {
  from: string;
  to?: string[];
  cc?: string[];
  ageHours: number;
  body?: string;
  html?: string;
  subject?: string;
  sent?: boolean;
  listUnsubscribe?: boolean;
  categories?: string[];
  autoSubmitted?: boolean;
  precedence?: string;
  listId?: boolean;
  replyTo?: string[];
  calendarMethod?: string;
}

const person = (email: string) => ({ name: null, email });

function msg(s: MsgSpec): MailMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    messageIdHeader: `<m${seq}@example.com>`,
    subject: s.subject ?? "Quarterly plan",
    from: person(s.from),
    to: (s.to ?? []).map(person),
    cc: (s.cc ?? []).map(person),
    date: new Date(NOW.getTime() - s.ageHours * H).toISOString(),
    bodyText: s.html === undefined ? (s.body ?? "Can you review the plan?") : null,
    bodyHtml: s.html ?? null,
    attachments: [],
    listUnsubscribe: s.listUnsubscribe ?? false,
    categories: s.categories ?? [],
    ...(s.sent !== undefined ? { sent: s.sent } : {}),
    ...(s.autoSubmitted !== undefined ? { autoSubmitted: s.autoSubmitted } : {}),
    ...(s.precedence !== undefined ? { precedence: s.precedence } : {}),
    ...(s.listId !== undefined ? { listId: s.listId } : {}),
    ...(s.replyTo !== undefined ? { replyTo: s.replyTo } : {}),
    ...(s.calendarMethod !== undefined ? { calendarMethod: s.calendarMethod } : {}),
  };
}

const bob = (ageHours: number, over: Partial<MsgSpec> = {}) => msg({ from: "bob@example.com", to: [ME], ageHours, ...over });
const mine = (ageHours: number, over: Partial<MsgSpec> = {}) => msg({ from: ME, to: ["bob@example.com"], ageHours, ...over });

function mailSignals(messages: MailMessage[], threadId = "t-1"): ThreadLoopSignals {
  const page = renderMailThread(MAIL, { threadId, messages });
  if (page.loop?.kind !== "mail") throw new Error("mail page carries no loop signals");
  return page.loop;
}

function none(): LoopSuppressions {
  return { senders: new Set(), threads: new Set() };
}

type Expect = null | Array<{ type: string; counterparty: string }>;

interface Row { name: string; messages: () => MailMessage[]; suppress?: (s: ThreadLoopSignals) => LoopSuppressions; expect: Expect }

const inbound = (who = "bob@example.com") => [{ type: "unanswered_inbound", counterparty: who }];
const outbound = (who = "bob@example.com") => [{ type: "unanswered_outbound", counterparty: who }];

const GMAIL_FORWARD = [
  "---------- Forwarded message ---------",
  "From: Carol Example <carol@example.com>",
  "Date: Mon, Aug 17, 2026 at 9:00 AM",
  "Subject: Venue for the offsite",
  "To: Me Example <me@example.com>",
  "",
  "Which venue did we settle on for the offsite? I need a headcount by Friday.",
].join("\n");
const APPLE_FORWARD = [
  "Begin forwarded message:",
  "",
  "From: Carol Example <carol@example.com>",
  "Subject: Venue for the offsite",
  "",
  "Which venue did we settle on for the offsite?",
].join("\n");

const MAIL_CORPUS: Row[] = [
  // Inbound: I owe the reply.
  { name: "inbound to me in To, 48h old", messages: () => [bob(48)], expect: inbound() },
  { name: "inbound 2h old is inside the grace window", messages: () => [bob(2)], expect: null },
  { name: "inbound exactly at the 24h grace edge opens", messages: () => [bob(24)], expect: inbound() },
  { name: "inbound 23h old is still inside grace", messages: () => [bob(23)], expect: null },
  { name: "CC-only inbound owes no reply", messages: () => [msg({ from: "bob@example.com", to: ["carol@example.com"], cc: [ME], ageHours: 48 })], expect: null },
  { name: "inbound not addressed to me (bcc or list delivery)", messages: () => [msg({ from: "bob@example.com", to: ["carol@example.com"], ageHours: 48 })], expect: null },
  { name: "newsletter with List-Unsubscribe", messages: () => [bob(48, { listUnsubscribe: true })], expect: null },
  { name: "Precedence: bulk mail", messages: () => [bob(48, { precedence: "bulk" })], expect: null },
  { name: "mail with a List-Id header", messages: () => [bob(48, { listId: true })], expect: null },
  { name: "no-reply Reply-To", messages: () => [bob(48, { replyTo: ["no-reply@example.com"] })], expect: null },
  { name: "noreply sender", messages: () => [msg({ from: "noreply@vendor.example", to: [ME], ageHours: 48 })], expect: null },
  { name: "notifications@ sender", messages: () => [msg({ from: "notifications@tracker.example", to: [ME], ageHours: 48 })], expect: null },
  { name: "promotions category from a stranger", messages: () => [bob(48, { categories: ["promotions"] })], expect: null },
  { name: "auto-reply (Auto-Submitted) owes nothing", messages: () => [bob(48, { autoSubmitted: true, body: "I am out of the office until Monday." })], expect: null },
  { name: "calendar invitation from a colleague (iCalendar METHOD)", messages: () => [bob(48, { calendarMethod: "REQUEST", subject: "Invitation: Sync @ Tue" })], expect: null },
  { name: "calendar notice by subject only", messages: () => [bob(48, { subject: "Accepted: Sync @ Tue" })], expect: null },
  { name: "a human forward titled Invitation still owes a reply", messages: () => [bob(48, { subject: "Fwd: Invitation: Sync @ Tue" })], expect: inbound() },
  { name: "their thanks-only reply owes nothing", messages: () => [bob(96, { body: "Here is the deck." }), mine(72, { body: "Looks good." }), bob(48, { body: "Thanks!" })], expect: null },
  { name: "their nudge does not restart the grace clock", messages: () => [bob(30), bob(1, { body: "Any update?" })], expect: inbound() },
  { name: "my reply answers them", messages: () => [bob(72), mine(48, { body: "Yes, approved." })], expect: null },
  { name: "my thanks-only reply to their question is not an answer", messages: () => [bob(72), mine(48, { body: "Thanks!" })], expect: inbound() },
  { name: "my thanks to a message that asked nothing is the reply", messages: () => [bob(72, { body: "Here is the deck." }), mine(48, { body: "Thanks, Bob!" })], expect: null },
  { name: "history older than 14 days never opens", messages: () => [bob(15 * 24)], expect: null },
  { name: "self-thread (notes to myself)", messages: () => [msg({ from: ME, to: [ME], ageHours: 96, body: "Remember to renew?" })], expect: null },
  { name: "Gmail SENT label marks my message even from an alias", messages: () => [bob(96), msg({ from: "alias@example.com", to: ["bob@example.com"], ageHours: 72, sent: true, body: "Approved." })], expect: null },
  { name: "question mark inside quoted history is not my question", messages: () => [mine(96, { body: "Sure.\n\nOn Mon, Bob wrote:\n> Can you send it?" })], expect: null },
  // Outbound: I am waiting on them.
  { name: "my question, 96h unanswered", messages: () => [mine(96, { body: "Can you send the contract?" })], expect: outbound() },
  { name: "my question inside the 72h grace", messages: () => [mine(48, { body: "Can you send the contract?" })], expect: null },
  { name: "my FYI without a question", messages: () => [mine(96, { body: "FYI, the deck is attached." })], expect: null },
  { name: "a question mark only inside a link is not a question", messages: () => [mine(96, { body: "See https://example.com/doc?id=42 for details." })], expect: null },
  { name: "their reply closes my question and, asking nothing back, owes nothing", messages: () => [mine(120, { body: "Can you send it?" }), bob(96, { body: "Sent." })], expect: null },
  { name: "their reply with a question back owes my reply", messages: () => [mine(120, { body: "Can you send it?" }), bob(96, { body: "Which version do you need?" })], expect: inbound() },
  { name: "their out-of-office is not an answer", messages: () => [mine(120, { body: "Can you send it?" }), bob(119, { autoSubmitted: true, body: "I am away." })], expect: outbound() },
  { name: "a calendar notice is not an answer", messages: () => [mine(120, { body: "Can we meet?" }), bob(110, { calendarMethod: "REPLY", subject: "Accepted: Meet" })], expect: outbound() },
  { name: "their thanks-only is not an answer to my question", messages: () => [mine(120, { body: "Can you sign the form?" }), bob(110, { body: "Thanks!" })], expect: outbound() },
  // Promises: what I said I would do.
  { name: "my promise with nothing after it", messages: () => [bob(96, { body: "Here is the brief." }), mine(48, { body: "Thanks, I'll send the estimate tomorrow." })], expect: [{ type: "commitment_owed_by_me", counterparty: "bob@example.com" }] },
  { name: "a promise I followed up on", messages: () => [mine(96, { body: "I'll send the estimate tomorrow." }), bob(80, { body: "Great." }), mine(48, { body: "Attached is the estimate." })], expect: null },
  { name: "a promise inside the 24h grace", messages: () => [bob(48, { body: "Here is the brief." }), mine(2, { body: "I will send the estimate." })], expect: null },
  { name: "a promise in Russian", messages: () => [bob(96, { body: "Вот бриф." }), mine(48, { body: "Спасибо, пришлю смету завтра." })], expect: [{ type: "commitment_owed_by_me", counterparty: "bob@example.com" }] },
  { name: "my question and my promise open both loops", messages: () => [mine(96, { body: "I'll send the deck Friday. Can you confirm the date?" })], expect: [
    { type: "commitment_owed_by_me", counterparty: "bob@example.com" }, { type: "unanswered_outbound", counterparty: "bob@example.com" }] },
  // Mutes.
  { name: "a muted sender opens nothing new", messages: () => [bob(48)], suppress: () => ({ senders: new Set([counterpartyKey("bob@example.com")]), threads: new Set() }), expect: null },
  { name: "a muted thread opens nothing new", messages: () => [bob(48)], suppress: s => ({ senders: new Set(), threads: new Set([s.threadRef]) }), expect: null },
  // A forward is judged by the sender's own note above the separator; the
  // forwarded message is someone else's words.
  { name: "my Gmail forward with an FYI note over someone else's question", messages: () => [mine(96, { subject: "Fwd: Venue", body: `FYI, see below.\n\n${GMAIL_FORWARD}` })], expect: null },
  { name: "my Apple Mail forward with a \"See below.\" note", messages: () => [mine(96, { subject: "Fwd: Venue", body: `See below.\n\n${APPLE_FORWARD}` })], expect: null },
  { name: "my forward with no note at all", messages: () => [mine(96, { subject: "Fwd: Venue", body: GMAIL_FORWARD })], expect: null },
  // Value: protects=a promise inside a forwarded message is its author's; fails_when=makesPromise reads the whole body again.
  { name: "my FYI forward of a promise someone else made opens no commitment", messages: () => [mine(96, { subject: "Fwd: Estimate", body: `FYI, see below.\n\n${GMAIL_FORWARD}\nI will send the estimate tomorrow.` })], expect: null },
  { name: "my FYI forward note that only shares a link", messages: () => [mine(96, { subject: "Fwd: Venue", body: `FYI, context: https://docs.example.com/view?id=42\n\n${GMAIL_FORWARD}` })], expect: null },
  { name: "my forward whose own note asks still waits on them", messages: () => [mine(96, { subject: "Fwd: Venue", body: `Can you take this one?\n\n${GMAIL_FORWARD}` })], expect: outbound() },
  { name: "their FYI forward is answered by my thanks", messages: () => [bob(40, { subject: "Fwd: Venue", body: `FYI, see below.\n\n${GMAIL_FORWARD}` }), mine(30, { body: "Thanks!" })], expect: null },
  { name: "their forward that asks me in its note still owes a real answer", messages: () => [bob(40, { subject: "Fwd: Venue", body: `Can you answer Carol?\n\n${GMAIL_FORWARD}` }), mine(30, { body: "Thanks!" })], expect: inbound() },
  // HTML-only mail is read through its text.
  { name: "HTML-only question to me", messages: () => [bob(48, { html: "<p>Can you <b>approve</b> the budget?</p>" })], expect: inbound() },
];

function opened(v: ThreadVerdict) {
  return v.open.map(o => ({ type: o.loopType as string, counterparty: o.counterpartyEmail ?? "" })).sort((a, b) => a.type.localeCompare(b.type));
}

describe("open-loop corpus: mail", () => {
  test("the corpus covers at least 30 threads", () => {
    expect(MAIL_CORPUS.length).toBeGreaterThanOrEqual(30);
  });
  for (const row of MAIL_CORPUS) {
    test(row.name, () => {
      const signals = mailSignals(row.messages());
      const verdict = detectThread(signals, NOW, row.suppress ? row.suppress(signals) : none());
      expect(opened(verdict)).toEqual(row.expect === null ? [] : [...row.expect].sort((a, b) => a.type.localeCompare(b.type)));
    });
  }
});

describe("close lane", () => {
  test("only a turn flip closes: my reply closes inbound, their reply closes outbound", () => {
    expect(detectThread(mailSignals([bob(72), mine(48, { body: "Done." })]), NOW, none()).close).toEqual(["unanswered_inbound"]);
    expect(detectThread(mailSignals([mine(120, { body: "Can you?" }), bob(96, { body: "Yes." })]), NOW, none()).close).toEqual(["unanswered_outbound"]);
  });
  test("grace, CC-only, list mail and mutes never fabricate a close of the other side", () => {
    // A fresh nudge inside grace: inbound is held, and the only close is the
    // outbound side, which their message did answer.
    expect(detectThread(mailSignals([bob(30), bob(1)]), NOW, none()).close).toEqual(["unanswered_outbound"]);
  });
  test("a following message of mine closes my earlier promise", () => {
    const v = detectThread(mailSignals([mine(96, { body: "I'll send it." }), mine(50, { body: "Here it is." })]), NOW, none());
    expect(v.close).toContain("commitment_owed_by_me");
  });
  test("a machine-only thread neither opens nor closes", () => {
    expect(detectThread(mailSignals([bob(48, { autoSubmitted: true })]), NOW, none())).toEqual({ open: [], close: [] });
  });
});

describe("text rules", () => {
  test("questions", () => {
    expect(asksQuestion("Can you?")).toBe(true);
    expect(asksQuestion("see https://x.example/a?b=1")).toBe(false);
    expect(asksQuestion("see www.x.example/a?b=1 now")).toBe(false);
  });
  test("a question counts only in the text above a forward separator", () => {
    expect(asksQuestion(`FYI, see below.\n\n${GMAIL_FORWARD}`)).toBe(false);
    expect(asksQuestion(`Thoughts?\n\n${GMAIL_FORWARD}`)).toBe(true);
    expect(asksQuestion("Is \"---------- Forwarded message ---------\" the separator Gmail writes?")).toBe(true);
  });
  test("acknowledgements", () => {
    for (const t of ["Thanks!", "thank you", "Got it, thanks.", "Thanks, Bob!", "Спасибо!", "ok"]) expect(isAcknowledgementOnly(t)).toBe(true);
    for (const t of ["Will do", "Thanks, can you also send the PDF?", "", "x".repeat(70)]) expect(isAcknowledgementOnly(t)).toBe(false);
  });
  test("promises", () => {
    for (const t of ["I'll send it tomorrow.", "I will follow up next week", "Let me check and get back to you", "Will do.", "Посмотрю и вернусь к тебе"]) expect(makesPromise(t)).toBe(true);
    for (const t of ["I'll be out of office", "Will you send it?", "Shall I send it?", "Thanks"]) expect(makesPromise(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chat: a direct conversation spans day pages; one thread across them.

const CHAT: ConnectorContext = { service: "slack", accountLabel: "acme-workspace" };

function chatDay(day: string, messages: Array<Partial<ChatMessage> & { self?: boolean; hoursAgo: number; text: string }>, direct = true): ChatDay {
  return {
    workspace: "acme",
    channelId: "D123",
    channelName: "bob",
    day,
    direct,
    messages: messages.map((m, i) => ({
      id: `${day}-${i}`,
      author: m.self ? { name: "Me", email: null } : { name: "Bob", email: null },
      ts: new Date(NOW.getTime() - m.hoursAgo * H).toISOString(),
      text: m.text,
      threadId: null,
      fromSelf: m.self ?? false,
      ...(m.bot !== undefined ? { bot: m.bot } : {}),
    })),
  };
}

function chatSignals(days: ChatDay[]): ThreadLoopSignals {
  const parts = days.map((d) => {
    const loop = renderChatDay(CHAT, d).loop;
    if (loop?.kind !== "chat") throw new Error("chat page carries no loop signals");
    return loop;
  });
  return mergeThreadSignals(parts);
}

describe("open-loop corpus: chat", () => {
  test("a direct message 30h unanswered owes a reply", () => {
    const v = detectThread(chatSignals([chatDay("2026-11-14", [{ hoursAgo: 30, text: "Can you look at the PR?" }])]), NOW, none());
    expect(opened(v).map(o => o.type)).toEqual(["unanswered_inbound"]);
    expect(v.open[0]!.counterpartyLabel).toBe("Bob");
  });
  test("my answer the next day closes yesterday's message", () => {
    const signals = chatSignals([
      chatDay("2026-11-13", [{ hoursAgo: 50, text: "Can you look at the PR?" }]),
      chatDay("2026-11-14", [{ hoursAgo: 30, self: true, text: "Merged it." }]),
    ]);
    expect(detectThread(signals, NOW, none()).open).toEqual([]);
  });
  test("a channel day (not direct) carries no loop signals", () => {
    expect(renderChatDay(CHAT, chatDay("2026-11-14", [{ hoursAgo: 30, text: "Anyone?" }], false)).loop).toBeUndefined();
  });
  test("a bot message in a direct conversation owes nothing", () => {
    const v = detectThread(chatSignals([chatDay("2026-11-14", [{ hoursAgo: 30, text: "Build failed?", bot: true }])]), NOW, none());
    expect(v.open).toEqual([]);
  });
  test("their thanks-only in chat owes nothing", () => {
    const v = detectThread(chatSignals([chatDay("2026-11-14", [{ hoursAgo: 40, self: true, text: "Done." }, { hoursAgo: 30, text: "thx" }])]), NOW, none());
    expect(v.open).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Calendar: an invitation I have not answered.

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev1",
    iCalUID: "ev1@example.com",
    title: "Design review",
    description: null,
    location: null,
    start: new Date(NOW.getTime() + 48 * H).toISOString(),
    end: new Date(NOW.getTime() + 49 * H).toISOString(),
    allDay: false,
    status: "confirmed",
    organizer: { name: "Bob", email: "bob@example.com" },
    attendees: [{ name: "Bob", email: "bob@example.com", response: "accepted" }, { name: null, email: ME, response: "needsAction" }],
    recurrence: null,
    ...over,
  };
}

const GCAL: ConnectorContext = { service: "google_calendar", accountLabel: ME };

function calSignals(e: CalendarEvent): CalendarLoopSignals {
  const loop = renderCalendarEvent(GCAL, e).loop;
  if (loop?.kind !== "calendar") throw new Error("calendar page carries no loop signals");
  return loop;
}

describe("open-loop corpus: calendar", () => {
  test("an invitation I have not answered opens an RSVP loop due at the start", () => {
    const v = detectCalendar(calSignals(event()), NOW, none());
    expect(v.open.map(o => [o.loopType, o.counterpartyEmail])).toEqual([["rsvp_owed", "bob@example.com"]]);
    expect(v.open[0]!.dueAt).toBe(event().start);
  });
  test("an answered invitation closes it", () => {
    const v = detectCalendar(calSignals(event({ attendees: [{ name: null, email: ME, response: "accepted" }] })), NOW, none());
    expect(v).toEqual({ open: [], close: ["rsvp_owed"], closedBy: "reply" });
  });
  test("a meeting I organise owes nothing", () => {
    const v = detectCalendar(calSignals(event({ organizer: { name: null, email: ME } })), NOW, none());
    expect(v.open).toEqual([]);
  });
  test("a past meeting never opens and closes as expired", () => {
    const past = event({ start: new Date(NOW.getTime() - 2 * H).toISOString(), end: new Date(NOW.getTime() - H).toISOString() });
    expect(detectCalendar(calSignals(past), NOW, none())).toEqual({ open: [], close: ["rsvp_owed"], closedBy: "expired" });
  });
  test("a cancelled meeting closes as cancelled", () => {
    expect(detectCalendar(calSignals(event({ status: "cancelled" })), NOW, none())).toEqual({ open: [], close: ["rsvp_owed"], closedBy: "cancelled" });
  });
  test("an event I am not invited to says nothing", () => {
    expect(detectCalendar(calSignals(event({ attendees: [] })), NOW, none())).toEqual({ open: [], close: [] });
  });
  test("a muted organiser opens nothing", () => {
    const v = detectCalendar(calSignals(event()), NOW, { senders: new Set([counterpartyKey("bob@example.com")]), threads: new Set() });
    expect(v.open).toEqual([]);
  });
});

describe("signals carry no message text", () => {
  test("bodies never reach the stored signals", () => {
    const signals = mailSignals([bob(48, { body: "The secret launch date is Tuesday?" })]);
    expect(JSON.stringify(signals)).not.toContain("launch date");
  });
});

describe("calendar series occurrences", () => {
  test("a series listing more than a hundred occurrences keeps its nearest one as the next start", async () => {
    const { calendarLoopSignals, nextCalendarStart } = await import("../src/core/loops/signals.ts");
    const now = new Date("2026-11-16T09:00:00Z");
    // Twice a day for 90 days ahead: 180 listed occurrences.
    const occurrences = Array.from({ length: 180 }, (_, i) => new Date(now.getTime() + 3_600_000 + i * 12 * 3_600_000).toISOString());
    const event: CalendarEvent = {
      id: "e1", iCalUID: "series@example.com", title: "Standup", start: new Date(now.getTime() - 30 * 86_400_000).toISOString(), end: null, allDay: false, status: "confirmed",
      organizer: { name: null, email: "lead@example.com" }, attendees: [{ name: null, email: "me@example.com", response: "needsAction" }],
      location: null, description: null, recurrence: null,
    } as unknown as CalendarEvent;
    // The series began a month ago; its start is behind us.
    const seriesStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const s = calendarLoopSignals({ service: "google_calendar", accountLabel: "me@example.com" }, event, seriesStart, "Standup", p => p.email ?? "", occurrences);
    expect(nextCalendarStart(s, now)).toBe(occurrences[0]!);
  });
});
