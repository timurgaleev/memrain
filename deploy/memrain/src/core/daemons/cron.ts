/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in an
 * IANA time zone through `Intl`, the same way `jobs/quiet-hours.ts` reads local
 * time. No dependency: the daemons need only the classic grammar.
 *
 * Grammar per field: `*`, `N`, `A-B`, any of those with `/STEP`, and comma
 * lists. Day-of-week takes 0-7 (0 and 7 are Sunday). When both day fields are
 * restricted a day matches either, as in classic cron.
 *
 * Windows are computed on local wall time and then mapped to an instant:
 *   - a wall time skipped by a spring-forward gap fires once, at the instant
 *     the gap ends (02:30 becomes 03:30 local);
 *   - a wall time repeated by a fall-back fires once, at its first occurrence.
 * The window key is the wall time plus the zone, so both cases yield exactly
 * one key per scheduled wall time. When a shifted gap time lands on the same
 * instant as a real one (02:30 and 03:30 on a spring-forward day), they are a
 * single run at that instant, always keyed by the earlier wall time.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronExpr {
  source: string;
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  /** 0 = Sunday. */
  weekdays: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

export interface CronFire {
  /** Local wall time, `YYYY-MM-DDTHH:MM`. */
  wall: string;
  /** The instant the window opens. */
  at: Date;
}

interface FieldSpec { name: string; min: number; max: number }

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Far enough back or ahead to reach a leap day from any date. */
const SEARCH_DAYS = 8 * 366;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function parseNumber(raw: string, f: FieldSpec): number {
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`cron ${f.name}: '${raw}' is not a number`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new CronError(`cron ${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(raw: string, f: FieldSpec): { values: number[]; restricted: boolean } {
  const out = new Set<number>();
  let restricted = false;
  for (const part of raw.split(",")) {
    if (part === "") throw new CronError(`cron ${f.name}: empty list item in '${raw}'`);
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || range === undefined) throw new CronError(`cron ${f.name}: '${part}' has more than one step`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) === 0) throw new CronError(`cron ${f.name}: step '${stepRaw}' must be a positive number`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.max;
      if (stepRaw !== undefined) restricted = true;
    } else {
      restricted = true;
      const bounds = range.split("-");
      if (bounds.length > 2) throw new CronError(`cron ${f.name}: '${range}' is not a range`);
      lo = parseNumber(bounds[0]!, f);
      hi = bounds.length === 2 ? parseNumber(bounds[1]!, f) : stepRaw !== undefined ? f.max : lo;
      if (hi < lo) throw new CronError(`cron ${f.name}: range ${lo}-${hi} runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), restricted };
}

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron '${expr}' must have 5 fields (minute hour day-of-month month day-of-week)`);
  const [min, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [
    ReturnType<typeof parseField>, ReturnType<typeof parseField>, ReturnType<typeof parseField>,
    ReturnType<typeof parseField>, ReturnType<typeof parseField>,
  ];
  const weekdays = [...new Set(dow.values.map(d => d % 7))].sort((a, b) => a - b);
  const cron: CronExpr = {
    source: parts.join(" "),
    minutes: min.values,
    hours: hour.values,
    days: dom.values,
    months: month.values,
    weekdays,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
  // Only day-of-month can make an expression impossible, and only when
  // day-of-week does not open other days.
  if (!(cron.domRestricted && cron.dowRestricted)
      && !cron.months.some(m => cron.days.some(d => d <= MAX_DAYS_IN_MONTH[m - 1]!))) {
    throw new CronError(`cron '${expr}' never fires: no listed month has that day`);
  }
  return cron;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The zone as given, after checking `Intl` knows it. */
export function assertTimeZone(tz: string): string {
  try {
    formatter(tz);
    return tz;
  } catch {
    throw new CronError(`unknown time zone '${tz}' (expected an IANA name such as Europe/Berlin)`);
  }
}

/** Local wall clock at `instant`, encoded as a UTC epoch (ms). */
function wallAt(instant: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(instant))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}

function offsetAt(instant: number, tz: string): number {
  return wallAt(instant, tz) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall time opens. Of the zone's offsets around it, an offset
 * that maps back to the same wall time is real; the earliest such instant wins
 * (fall-back). When none does, the wall time sits in a gap and opens when the
 * gap ends, which is the wall time read with the earlier (smaller) offset.
 */
function wallToInstant(wall: number, tz: string): number {
  const offsets = [...new Set([offsetAt(wall - DAY_MS / 2, tz), offsetAt(wall, tz), offsetAt(wall + DAY_MS / 2, tz)])];
  const real = offsets.map(o => wall - o).filter(i => wallAt(i, tz) === wall).sort((a, b) => a - b);
  if (real.length > 0) return real[0]!;
  return wall - Math.min(...offsets);
}

function dayMatches(cron: CronExpr, day: Date): boolean {
  if (!cron.months.includes(day.getUTCMonth() + 1)) return false;
  const dom = cron.days.includes(day.getUTCDate());
  const dow = cron.weekdays.includes(day.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

function wallString(wall: number): string {
  return new Date(wall).toISOString().slice(0, 16);
}

/**
 * Every window of one local day, in wall order. Away from a zone transition
 * the offset is constant and each instant is plain arithmetic; only a day
 * near a transition maps each wall time through `wallToInstant`. Near one,
 * instants can run out of wall order (a gap time opens after the next hour),
 * which is why callers compare instants, never positions.
 */
function dayFires(cron: CronExpr, day: number, tz: string): CronFire[] {
  if (!dayMatches(cron, new Date(day))) return [];
  const before = offsetAt(day - DAY_MS / 2, tz);
  const steady = before === offsetAt(day + DAY_MS / 2, tz) && before === offsetAt(day + DAY_MS * 1.5, tz);
  const out: CronFire[] = [];
  for (const h of cron.hours) {
    for (const m of cron.minutes) {
      const wall = day + h * 3_600_000 + m * MINUTE_MS;
      out.push({ wall: wallString(wall), at: new Date(steady ? wall - before : wallToInstant(wall, tz)) });
    }
  }
  return out;
}

/**
 * Walk local days from the one holding `instant` in direction `dir`. The first
 * day with an acceptable window settles it, together with the day after it in
 * walk order, since a transition can push a window across midnight.
 */
function search(cron: CronExpr, instant: number, tz: string, dir: 1 | -1, accept: (at: number) => boolean): CronFire | null {
  const startWall = wallAt(instant, tz);
  const startDay = startWall - (((startWall % DAY_MS) + DAY_MS) % DAY_MS);
  for (let d = -1; d <= SEARCH_DAYS; d++) {
    const day = startDay + dir * d * DAY_MS;
    const hits = dayFires(cron, day, tz).filter(f => accept(f.at.getTime()));
    if (hits.length === 0) continue;
    hits.push(...dayFires(cron, day + dir * DAY_MS, tz).filter(f => accept(f.at.getTime())));
    return hits.reduce((best, f) => (dir * (best.at.getTime() - f.at.getTime()) > 0 ? f : best));
  }
  return null;
}

/** The latest window opening at or before `now`. */
export function previousFire(cron: CronExpr, now: Date, tz: string): CronFire | null {
  const t = now.getTime();
  return search(cron, t, tz, -1, at => at <= t);
}

/** The first window opening strictly after `after`. */
export function nextFire(cron: CronExpr, after: Date, tz: string): CronFire | null {
  const t = after.getTime();
  return search(cron, t, tz, 1, at => at > t);
}

/** The stable key of a window: its wall time and zone. */
export function windowKey(fire: CronFire, tz: string): string {
  return `${fire.wall}@${tz}`;
}
