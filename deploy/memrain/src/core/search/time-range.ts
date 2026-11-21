/**
 * Relative time in a search query ("last month", "gestern", and the Russian
 * forms) → the calendar range it points at, and a soft scope that lifts hits
 * dated inside that range without dropping any. The Russian words are written
 * as \u escapes, which the RegExp source reads as the letters themselves.
 *
 * The parser is deterministic and deliberately small: today, yesterday, this
 * or last week, month and year, in English, German and Russian (the languages
 * the brain is written in). Weeks run Monday to Sunday. "This week / month /
 * year" ends at the reference day. A query naming two different spans ("what
 * changed between last month and this week") abstains rather than guess which
 * one the caller meant. Days are calendar days, compared as YYYY-MM-DD.
 */

export interface DayRange {
  /** First day, YYYY-MM-DD, inclusive. */
  start: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  end: string;
}

export interface QueryTimeRange extends DayRange {
  /** The phrase the range came from, as written. */
  cue: string;
}

type Span = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "this_year" | "last_year";

const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const W = String.raw`\p{L}*`;
const LAST_DE = String.raw`(?:letzte|vorige|vergangene)[nrsm]?`;
const THIS_DE = String.raw`(?:diese[nrsm]?|in diesem|in dieser)`;
const LAST_RU = String.raw`(?:\u043F\u0440\u043E\u0448\u043B|\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449)${W}`;
const THIS_RU = String.raw`(?:\u044D\u0442\u043E\u043C|\u044D\u0442\u043E\u0442|\u044D\u0442\u0443|\u044D\u0442\u043E\u0439|\u044D\u0442\u0430|\u0442\u0435\u043A\u0443\u0449${W})`;

const CUES: ReadonlyArray<{ span: Span; pattern: string }> = [
  { span: "today", pattern: String.raw`today|heute|\u0441\u0435\u0433\u043E\u0434\u043D\u044F` },
  { span: "yesterday", pattern: String.raw`yesterday|gestern|\u0432\u0447\u0435\u0440\u0430` },
  { span: "this_week", pattern: String.raw`this week|${THIS_DE} woche|${THIS_RU} \u043D\u0435\u0434\u0435\u043B${W}` },
  { span: "last_week", pattern: String.raw`last week|${LAST_DE} woche|${LAST_RU} \u043D\u0435\u0434\u0435\u043B${W}` },
  { span: "this_month", pattern: String.raw`this month|${THIS_DE} monat|${THIS_RU} \u043C\u0435\u0441\u044F\u0446${W}` },
  { span: "last_month", pattern: String.raw`last month|${LAST_DE} monat|${LAST_RU} \u043C\u0435\u0441\u044F\u0446${W}` },
  { span: "this_year", pattern: String.raw`this year|${THIS_DE} jahr|${THIS_RU} \u0433\u043E\u0434${W}` },
  { span: "last_year", pattern: String.raw`last year|${LAST_DE} jahr|${LAST_RU} \u0433\u043E\u0434${W}` },
];

const CUE_RES = CUES.map(({ span, pattern }) => ({
  span,
  re: new RegExp(`${L}(?:${pattern.replaceAll(" ", String.raw`\s+`)})${R}`, "giu"),
}));

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(parseDay(day).getTime() + n * DAY_MS));
}

function resolveSpan(span: Span, ref: string): DayRange {
  const r = parseDay(ref);
  const y = r.getUTCFullYear();
  const m = r.getUTCMonth();
  const monday = addDays(ref, -((r.getUTCDay() + 6) % 7));
  switch (span) {
    case "today": return { start: ref, end: ref };
    case "yesterday": { const d = addDays(ref, -1); return { start: d, end: d }; }
    case "this_week": return { start: monday, end: ref };
    case "last_week": return { start: addDays(monday, -7), end: addDays(monday, -1) };
    case "this_month": return { start: toDay(new Date(Date.UTC(y, m, 1))), end: ref };
    case "last_month": return { start: toDay(new Date(Date.UTC(y, m - 1, 1))), end: toDay(new Date(Date.UTC(y, m, 0))) };
    case "this_year": return { start: `${y}-01-01`, end: ref };
    case "last_year": return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
  }
}

/**
 * The span a query's relative time words name, resolved against `referenceDay`
 * (YYYY-MM-DD), or null when it names none or names more than one.
 */
export function parseQueryTimeRange(query: string, referenceDay: string): QueryTimeRange | null {
  if (!ISO_DAY.test(referenceDay)) return null;
  let found: { span: Span; cue: string } | null = null;
  for (const { span, re } of CUE_RES) {
    for (const m of query.matchAll(re)) {
      if (found && found.span !== span) return null;
      found ??= { span, cue: m[0] };
    }
  }
  if (!found) return null;
  return { ...resolveSpan(found.span, referenceDay), cue: found.cue };
}

/** Whether a content day falls in the range, widened by `slackDays` on each side. */
export function dayInRange(day: string | null | undefined, range: DayRange, slackDays = 2): boolean {
  if (!day || !ISO_DAY.test(day)) return false;
  return day >= addDays(range.start, -slackDays) && day <= addDays(range.end, slackDays);
}

/**
 * Lift in-range hits into the first `k` without dropping anything: the top
 * ⌈k/2⌉ hits keep their places, the rest of the first `k` slots go to in-range
 * hits in their ranked order, and every other hit follows in ranked order. The
 * result is a permutation of the input; with no in-range hit below the kept
 * head, the input order is returned unchanged.
 */
export function applyTimeScope<T>(hits: readonly T[], k: number, inRange: (hit: T) => boolean): T[] {
  const keep = Math.ceil(Math.max(1, k) / 2);
  const lifted = new Set<number>();
  for (let i = keep; i < hits.length && lifted.size < Math.max(0, k - keep); i++) {
    if (inRange(hits[i]!)) lifted.add(i);
  }
  if (lifted.size === 0) return [...hits];
  return [
    ...hits.slice(0, keep),
    ...[...lifted].map((i) => hits[i]!),
    ...hits.filter((_, i) => i >= keep && !lifted.has(i)),
  ];
}
