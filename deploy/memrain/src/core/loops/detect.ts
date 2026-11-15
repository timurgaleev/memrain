/**
 * The open-loop detector: a pure, model-free verdict over one thread's reply
 * state (signals.ts). It decides whether someone is waiting:
 *
 *   unanswered_inbound     the last substantive message is theirs, to me: I owe the reply
 *   unanswered_outbound    the last substantive message is my question: I am waiting
 *   commitment_owed_by_me  my last promise ("I'll send...") has nothing of mine after it
 *   rsvp_owed              an invitation I have not answered, for a meeting still ahead
 *
 * Precision is the product; the labelled corpus in tests/loops_detect.test.ts
 * pins every rule below, and a new false-positive class gets a row there first.
 *
 *   - machine mail (no-reply senders, RFC 3834 auto-replies, calendar notices,
 *     chat bots) neither opens nor closes a loop: an out-of-office is not the
 *     answer to my question, and an invitation is not a reply
 *   - list mail (List-Unsubscribe, List-Id, Precedence: bulk|list|junk, a
 *     no-reply Reply-To) owes no reply; a bulk category owes none either unless
 *     I wrote in the thread
 *   - CC-only (or Bcc) inbound owes no reply: I must be in To
 *   - their thanks-only message owes no reply and answers nothing
 *   - their answer to my question that asks nothing back owes no reply
 *   - my thanks-only reply to their question is not an answer; it neither
 *     closes nor restarts anything ("Will do" is a promise and does count)
 *   - my message without a question mark outside a link is an FYI, not an ask
 *   - a thread where every participant is me opens nothing
 *   - grace: inbound 24 h, outbound 72 h, promises 24 h, measured from the
 *     oldest message of the trailing run, so a nudge never restarts the clock
 *   - nothing opens from a thread whose last activity is older than 14 days
 *   - a muted sender or thread opens nothing new; existing loops stay as they are
 *
 * Only a turn flip closes a loop: my reply closes the inbound side, theirs the
 * outbound side, a later message of mine a promise. Grace, CC-only, list mail
 * and mutes withhold an open but never fabricate a close.
 */
import { nextCalendarStart, type CalendarLoopSignals, type MessageSignal, type ThreadLoopSignals } from "./signals.ts";

export const INBOUND_GRACE_HOURS = 24;
export const OUTBOUND_GRACE_HOURS = 72;
export const PROMISE_GRACE_HOURS = 24;
/** Loops never open from history older than this. */
export const OPEN_WINDOW_DAYS = 14;

export type LoopType =
  | "unanswered_inbound"
  | "unanswered_outbound"
  | "commitment_owed_by_me"
  | "commitment_owed_to_me"
  | "rsvp_owed"
  | "decision_pending";

export const LOOP_TYPES: readonly LoopType[] = [
  "unanswered_inbound", "unanswered_outbound", "commitment_owed_by_me", "commitment_owed_to_me", "rsvp_owed", "decision_pending",
];

export interface LoopSuppressions {
  /** counterparty keys (signals.ts counterpartyKey). */
  senders: ReadonlySet<string>;
  /** thread refs. */
  threads: ReadonlySet<string>;
}

export interface LoopSpec {
  loopType: LoopType;
  /** Shown name (outside text) and address hash of whom the loop is about. */
  counterpartyLabel: string | null;
  counterpartyKey: string | null;
  /** The plain address, for tests and summaries only; never stored. */
  counterpartyEmail?: string;
  summary: string;
  openedAt: string;
  lastActivityAt: string;
  /** When the message (or event) the loop rests on happened. */
  evidenceAt: string;
  dueAt?: string;
}

export interface ThreadVerdict {
  open: LoopSpec[];
  close: LoopType[];
}

export interface CalendarVerdict extends ThreadVerdict {
  closedBy?: "reply" | "expired" | "cancelled";
}

const HOUR = 3_600_000;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** A question mark outside any link. */
export function asksQuestion(text: string): boolean {
  return text.replace(URL_RE, "").includes("?");
}

const ACK_WORDS = String.raw`thanks|thank you|thx|ty|many thanks|thanks so much|thank you so much|got it|noted|received|ack|ok|okay|sounds good|cheers|great|perfect|спасибо|благодарю|спс|ок|окей|понял|поняла|принято|отлично`;
const ACK_ONLY_RE = new RegExp(String.raw`^(?:(?:${ACK_WORDS})[\s!.,)]*)+$`, "iu");
const SIGN_OFF_NAME_RE = /^\p{Lu}[\p{Ll}.]{0,19}$/u;

function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** "Thanks, Bob!" without its ", Bob!" (or " - Bob"). */
function dropSignOffName(t: string): string {
  const at = Math.max(t.lastIndexOf(","), t.lastIndexOf(" -"), t.lastIndexOf(" –"), t.lastIndexOf(" —"));
  if (at <= 0) return t;
  let tail = t.slice(at + 1).trim();
  if ("-–—".includes(tail[0] ?? "x")) tail = tail.slice(1).trim();
  return SIGN_OFF_NAME_RE.test(trimEnd(tail, "!. ")) ? t.slice(0, at) : t;
}

/** A short message that only acknowledges ("Thanks!", "Got it, thanks.", "Thanks, Bob!"). */
export function isAcknowledgementOnly(text: string): boolean {
  const t = text.split(/\s/).filter(Boolean).join(" ");
  if (t.length === 0 || t.length > 60) return false;
  return ACK_ONLY_RE.test(t) || ACK_ONLY_RE.test(dropSignOffName(t));
}

const PROMISE_VERBS = String.raw`send|share|get back|follow up|check|look into|take a look|review|circle back|confirm|update you|forward|prepare|draft|ping|call|book|schedule|fix|sort (?:it|this|that) out`;
const PROMISE_RES = [
  new RegExp(String.raw`\b(?:i['’]ll|i will|i['’]m going to|let me)\s+(?:(?:also|then|quickly|definitely|probably)\s+)?(?:${PROMISE_VERBS})\b`, "i"),
  /(?:^|[\s.!,])will do\b(?![^.!?\n]*\?)/i,
  /(?:^|[^\p{L}])(?:пришлю|отправлю|вышлю|перешлю|посмотрю|проверю|уточню|вернусь|отпишусь|напишу|подготовлю|сделаю)(?:$|[^\p{L}])/iu,
];

/** A first-person promise to do something ("I'll send it tomorrow", "Let me check", "Will do"). */
export function makesPromise(text: string): boolean {
  return PROMISE_RES.some(re => re.test(text));
}

const ms = (iso: string) => Date.parse(iso);
const ageHours = (iso: string, now: Date) => (now.getTime() - ms(iso)) / HOUR;

function summaryLine(prefix: string, who: string | null, title: string): string {
  return `${prefix}${who ? ` ${who}` : ""}: "${title}"`.slice(0, 500);
}

/** Address part of a "Name <addr>" label, for tests and summaries. */
function emailOf(label: string | undefined | null): string | undefined {
  if (!label) return undefined;
  const t = label.trim();
  const open = t.lastIndexOf("<");
  if (open !== -1 && t.endsWith(">")) {
    const inner = t.slice(open + 1, -1);
    if (inner.includes("@") && !/[\s<>]/.test(inner)) return inner.toLowerCase();
  }
  return t.includes("@") && !t.includes(" ") ? t.toLowerCase() : undefined;
}

function spec(type: LoopType, who: { label: string | null; key: string | null }, prefix: string, title: string, since: MessageSignal, last: MessageSignal): LoopSpec {
  const email = emailOf(who.label);
  return {
    loopType: type,
    counterpartyLabel: who.label,
    counterpartyKey: who.key,
    ...(email ? { counterpartyEmail: email } : {}),
    summary: summaryLine(prefix, who.label, title),
    openedAt: since.at,
    lastActivityAt: last.at,
    evidenceAt: last.at,
  };
}

/** Pure verdict over a mail thread or a direct conversation. */
export function detectThread(thread: ThreadLoopSignals, now: Date, suppress: LoopSuppressions): ThreadVerdict {
  const messages = thread.messages.filter(m => Number.isFinite(ms(m.at)) && ms(m.at) > 0);

  // Substantive messages: machine mail is dropped, so is their thanks-only,
  // and so is my thanks-only answer to their open question.
  const substantive: MessageSignal[] = [];
  let theirQuestionPending = false;
  for (const m of messages) {
    if (m.machine) continue;
    if (!m.mine) {
      if (m.ack) continue;
      theirQuestionPending = m.question;
    } else if (theirQuestionPending && m.ack) {
      continue;
    } else {
      theirQuestionPending = false;
    }
    substantive.push(m);
  }
  if (substantive.length === 0) return { open: [], close: [] };

  const last = substantive[substantive.length - 1]!;
  const lastIsMine = last.mine;
  const close: LoopType[] = [lastIsMine ? "unanswered_inbound" : "unanswered_outbound"];

  // A promise is kept (or at least followed up) by a later message of mine.
  const promiseIdx = findLastIndex(substantive, m => m.mine && m.promise);
  const promiseKept = promiseIdx !== -1 && substantive.slice(promiseIdx + 1).some(m => m.mine);
  if (promiseKept) close.push("commitment_owed_by_me");

  const someoneElse = substantive.some(m => !m.mine || (m.toKey !== undefined));
  if (!someoneElse) return { open: [], close };
  if (ageHours(last.at, now) > OPEN_WINDOW_DAYS * 24) return { open: [], close };
  const threadMuted = suppress.threads.has(thread.threadRef);
  const muted = (key: string | null) => threadMuted || (key !== null && suppress.senders.has(key));
  const lastOther = [...substantive].reverse().find(m => !m.mine);
  const counterpartyOfMine = (m: MessageSignal) =>
    m.toKey ? { label: m.to ?? null, key: m.toKey } : lastOther ? { label: lastOther.from, key: lastOther.fromKey } : null;

  // The trailing run: substantive messages since the last turn flip.
  let runStart = substantive.length - 1;
  while (runStart > 0 && substantive[runStart - 1]!.mine === lastIsMine) runStart--;
  const run = substantive.slice(runStart);
  const open: LoopSpec[] = [];

  if (!lastIsMine) {
    // Their answer to my question, asking nothing back, is the end of the exchange.
    const before = substantive[runStart - 1];
    const answersMyAsk = before !== undefined && before.question && !run.some(m => m.question);
    const owes = !answersMyAsk && !last.bulk && last.toMe
      && !(last.category && !substantive.some(m => m.mine))
      && !muted(last.fromKey);
    const since = run.find(m => m.toMe) ?? last;
    if (owes && ageHours(since.at, now) >= INBOUND_GRACE_HOURS) {
      open.push(spec("unanswered_inbound", { label: last.from, key: last.fromKey }, "Reply owed to", thread.title, since, last));
    }
  } else if (last.question) {
    const who = counterpartyOfMine(last);
    const since = run.find(m => m.question) ?? last;
    if (who && !muted(who.key) && ageHours(since.at, now) >= OUTBOUND_GRACE_HOURS) {
      open.push(spec("unanswered_outbound", who, "Waiting on", thread.title, since, last));
    }
  }

  if (promiseIdx !== -1 && !promiseKept) {
    const promise = substantive[promiseIdx]!;
    const who = counterpartyOfMine(promise);
    if (who && !muted(who.key) && ageHours(promise.at, now) >= PROMISE_GRACE_HOURS) {
      open.push(spec("commitment_owed_by_me", who, "You promised", thread.title, promise, last));
    }
  }
  return { open, close };
}

/**
 * Pure verdict over a calendar event: an invitation I owe an answer to.
 * `changedAt` is when the event last changed in the brain; it stands for the
 * loop's activity, so a loop the owner closed reopens only after the event
 * itself changes again.
 */
export function detectCalendar(event: CalendarLoopSignals, now: Date, suppress: LoopSuppressions, changedAt: string = now.toISOString()): CalendarVerdict {
  if (event.myResponse === null) return { open: [], close: [] };
  if (event.status === "cancelled") return { open: [], close: ["rsvp_owed"], closedBy: "cancelled" };
  // A series stays owed while any listed occurrence is still ahead.
  const next = nextCalendarStart(event, now);
  if (next === null) return { open: [], close: ["rsvp_owed"], closedBy: "expired" };
  if (event.myResponse !== "needsaction") return { open: [], close: ["rsvp_owed"], closedBy: "reply" };
  if (event.organizerMine) return { open: [], close: [] };
  if (suppress.threads.has(event.threadRef) || (event.organizerKey !== null && suppress.senders.has(event.organizerKey))) {
    return { open: [], close: [] };
  }
  const email = emailOf(event.organizer);
  return {
    open: [{
      loopType: "rsvp_owed",
      counterpartyLabel: event.organizer,
      counterpartyKey: event.organizerKey,
      ...(email ? { counterpartyEmail: email } : {}),
      summary: summaryLine("RSVP owed to", event.organizer, event.title),
      openedAt: changedAt,
      lastActivityAt: changedAt,
      evidenceAt: next,
      dueAt: next,
    }],
    close: [],
  };
}

function findLastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
}
