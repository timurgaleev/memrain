/**
 * Time in a search query ("last month", "in March", "two weeks ago", "Q3 2025",
 * "gestern", and the Russian forms) -> the calendar range it points at, and a
 * soft scope that lifts hits dated inside that range without dropping any.
 *
 * The English cues come from the deterministic grammar (temporal-grammar.ts):
 * explicit dates, months, quarters, years, "N days ago", weekdays, seasons,
 * calendar spans ("last month" is the previous calendar month) and rolling
 * windows ("in the last month" is the last 30 days). German and Russian (the
 * other languages the brain is written in) add today, yesterday and this or
 * last week, month and year. The Russian words are written as \u escapes,
 * which the RegExp source reads as the letters themselves.
 *
 * The parser abstains, leaving retrieval unscoped, on a question that asks for
 * a duration ("how long…", "how many days since…") and on one that names two
 * separate times ("what changed between last month and this week"); mentions
 * joined by "and/or/to/through/-" ("in March and April", "between May 3 and
 * May 9") are one range. Cues inside quotes are names, not times. Days are
 * calendar days, compared as YYYY-MM-DD; weeks run Monday to Sunday.
 */
import {
  addDays,
  asksForDuration,
  calendarUnitRange,
  findTimeMentions,
  type DayRange,
  type RelativeUnit,
  type Rule,
  type TimeMention,
} from "./temporal-grammar.ts";

export { addDays, type DayRange };

export interface QueryTimeRange extends DayRange {
  /** The phrase the range came from, as written. */
  cue: string;
}

const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const W = String.raw`\p{L}*`;
const LAST_DE = String.raw`(?:letzte|vorige|vergangene)[nrsm]?`;
const THIS_DE = String.raw`(?:diese[nrsm]?|in diesem|in dieser)`;
const LAST_RU = String.raw`(?:\u043F\u0440\u043E\u0448\u043B|\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449)${W}`;
const THIS_RU = String.raw`(?:\u044D\u0442\u043E\u043C|\u044D\u0442\u043E\u0442|\u044D\u0442\u0443|\u044D\u0442\u043E\u0439|\u044D\u0442\u0430|\u0442\u0435\u043A\u0443\u0449${W})`;
const WEEK = String.raw`woche|\u043D\u0435\u0434\u0435\u043B${W}`;
const MONTH = String.raw`monat|\u043C\u0435\u0441\u044F\u0446${W}`;
const YEAR = String.raw`jahr|\u0433\u043E\u0434${W}`;

const word = (pattern: string): RegExp => new RegExp(`${L}(?:${pattern.replaceAll(" ", String.raw`\s+`)})${R}`, "giu");

/** German and Russian cues, resolved the way their English counterparts are. */
const LOCAL_RULES: Rule[] = [
  { re: word(String.raw`heute|\u0441\u0435\u0433\u043E\u0434\u043D\u044F`), resolve: (_m, ref) => ({ start: ref, end: ref, kind: "relative" }) },
  { re: word(String.raw`gestern|\u0432\u0447\u0435\u0440\u0430`), resolve: (_m, ref) => {
    const d = addDays(ref, -1);
    return { start: d, end: d, kind: "relative" };
  } },
  ...(["this", "last"] as const).flatMap(lead => ([["week", WEEK], ["month", MONTH], ["year", YEAR]] as const).map(([unit, noun]): Rule => {
    const leadDe = lead === "this" ? THIS_DE : LAST_DE;
    const leadRu = lead === "this" ? THIS_RU : LAST_RU;
    const [de, ru] = noun.split("|") as [string, string];
    return {
      re: word(`${leadDe} ${de}|${leadRu} ${ru}`),
      resolve: (_m, ref) => ({ ...calendarUnitRange(lead, unit as RelativeUnit, ref), kind: "relative" }),
    };
  })),
];

/** Two mentions joined by "and/or/to/through/-" with nothing else between them are one span. */
function joined(text: string, a: TimeMention, b: TimeMention): boolean {
  const between = text.slice(a.index + a.cue.length, b.index).trim().toLowerCase();
  return /^(?:and|or|to|through|until|till|-|\u2013|\u2014|und|oder|bis|\u0438|\u0438\u043B\u0438|\u0434\u043E)$/u.test(between);
}

/**
 * The range a query's time words name, resolved against `referenceDay`
 * (YYYY-MM-DD), or null when it names none, asks for a duration, or names two
 * separate times.
 */
export function parseQueryTimeRange(query: string, referenceDay: string): QueryTimeRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDay)) return null;
  const mentions = findTimeMentions(query, referenceDay, "past", LOCAL_RULES);
  if (mentions.length === 0 || asksForDuration(query)) return null;
  let start = mentions[0]!.start;
  let end = mentions[0]!.end;
  let cue = mentions[0]!.cue;
  for (let i = 1; i < mentions.length; i++) {
    if (!joined(query, mentions[i - 1]!, mentions[i]!)) return null;
    start = mentions[i]!.start < start ? mentions[i]!.start : start;
    end = mentions[i]!.end > end ? mentions[i]!.end : end;
    cue = query.slice(mentions[0]!.index, mentions[i]!.index + mentions[i]!.cue.length);
  }
  return { start, end, cue };
}

/** Whether a content day falls in the range, widened by `slackDays` on each side. */
export function dayInRange(day: string | null | undefined, range: DayRange, slackDays = 2): boolean {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
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
