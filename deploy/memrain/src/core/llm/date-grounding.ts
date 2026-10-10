/**
 * Date grounding for extraction prompts.
 *
 * A stored claim can carry three different times, and they must never be
 * conflated:
 *
 *   observation time  when the source text was written or said — a chat turn's
 *                     timestamp, a dated note. Relative phrases ("last week",
 *                     "by Friday") resolve against it.
 *   validity time     when the claim became true (`entity_facts.valid_from`).
 *                     A note written in March can say "we closed the round in
 *                     2024".
 *   recording time    when memrain stored it (`written_at`). Never used to
 *                     interpret text.
 *
 * "Went to Lisbon last week" is useless months later, and resolving it against
 * the day the extractor happens to run silently re-dates every backfilled
 * transcript. So the rule names the observation date, which travels in the
 * user message, and the system prompt stays byte-identical across calls.
 *
 * Pure: no engine, no IO.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Earliest validity date an extractor may assert. */
const MIN_EVENT_YEAR = 1900;

/** `YYYY-MM-DD` of a Date in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A real calendar day as `YYYY-MM-DD`, or null. Accepts a bare day or any
 * value that STARTS with one (an ISO timestamp, a `date:` truth field);
 * rejects impossible days like 2026-02-30 rather than letting Date roll them
 * over into March.
 */
export function calendarDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, 10);
  if (!DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || isoDay(d) !== s) return null;
  return s;
}

/**
 * The static rule for the extractor's SYSTEM prompt. It contains no date, so
 * the system prompt stays cache-stable; the date itself goes in the user
 * message via `observationDateLine`.
 */
export const DATE_GROUNDING_BLOCK = [
  "",
  "Dates: the user message states its observation date (when the text was written or said).",
  "Rewrite every relative time reference (yesterday, last week, next month, recently, in 18 months, by Friday)",
  "as an absolute date or bound resolved against the observation date, never against today's date:",
  "'flew to Lisbon last week' -> 'flew to Lisbon the week of 2026-03-02', 'due by Friday' -> 'due by 2026-03-13'.",
  "Do not leave the relative phrase beside its date. If the observation date is unknown, keep relative",
  "phrases exactly as written and do not invent dates.",
  '- Add "valid_from" to every fact object: "YYYY-MM-DD" when the claim states or implies the specific date it',
  "  became true (resolved against the observation date), else null. Never use the observation date as a guess.",
].join("\n");

/** The user-message line carrying the observation date (or its absence). */
export function observationDateLine(observationDate: string | null | undefined): string {
  const day = calendarDay(observationDate ?? undefined);
  return day
    ? `Observation date: ${day} (when this text was written or said; resolve relative dates against it).`
    : "Observation date: unknown (keep relative dates as written).";
}

/**
 * Validate an extractor-stated validity date. Strict `YYYY-MM-DD`, a real
 * day, no earlier than 1900 and no later than one year past `now`. Anything
 * else is the model guessing, and a guessed anchor is worse than none.
 */
export function parseExtractedEventDate(raw: unknown, now: Date = new Date()): string | null {
  if (typeof raw !== "string" || !DAY_RE.test(raw.trim())) return null;
  const day = calendarDay(raw);
  if (day === null) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  if (d.getUTCFullYear() < MIN_EVENT_YEAR) return null;
  const max = new Date(now.getTime());
  max.setUTCFullYear(max.getUTCFullYear() + 1);
  if (d.getTime() > max.getTime()) return null;
  return day;
}

/** Which input set a fact's `valid_from`. */
export type ValidFromSource = "extracted" | "caller" | "observation";

/**
 * `valid_from` precedence: a date the extractor stated (already validated) >
 * a caller-supplied time (the turn's own timestamp) > the observation date >
 * nothing. Unlike the write time, NULL is a real answer here: the decay and
 * recency surfaces fall back to `written_at` on their own.
 */
export function resolveValidFrom(input: {
  extracted?: string | null;
  caller?: string | null;
  observation?: string | null;
}): { date: string; source: ValidFromSource } | null {
  const extracted = calendarDay(input.extracted ?? undefined);
  if (extracted) return { date: extracted, source: "extracted" };
  const caller = calendarDay(input.caller ?? undefined);
  if (caller) return { date: caller, source: "caller" };
  const observation = calendarDay(input.observation ?? undefined);
  if (observation) return { date: observation, source: "observation" };
  return null;
}

/**
 * True when `text` holds a relative time phrase NOT followed by a
 * parenthesized absolute date. Judge-free, for tests and the bench.
 */
const RELATIVE_PHRASE_RE =
  /\b(?:yesterday|today|tomorrow|tonight|last (?:week|month|year|night|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (?:week|month|year|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:week|month|year|weekend|morning|afternoon|evening)|recently|\d+ (?:days?|weeks?|months?|years?) ago|in \d+ (?:days?|weeks?|months?|years?))\b(?!\s*\()/i;

export function hasUnresolvedRelativeDate(text: string): boolean {
  return RELATIVE_PHRASE_RE.test(text);
}
