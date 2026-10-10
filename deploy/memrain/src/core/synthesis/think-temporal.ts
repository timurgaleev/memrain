/**
 * The time frame think reads in: today's date (or a caller-supplied reference
 * date) in the brain's timezone, and the content date of each gathered page.
 * Relative time words in the question ("last month") resolve against the
 * reference date; relative words inside a page resolve against that page's
 * date.
 *
 * Only content dates reach the model. A document whose effective date fell
 * back to its row timestamps (source 'fallback' or NULL) carries no date: that
 * time says when the row was written, not when the content happened.
 *
 * Pure apart from the MEMRAIN_TIMEZONE read in `thinkTimeZone`.
 */

export interface ThinkTemporalContext {
  /** YYYY-MM-DD in `timeZone`. */
  referenceDate: string;
  /** IANA zone from MEMRAIN_TIMEZONE, or 'UTC' when unset or invalid. */
  timeZone: string;
  /** True when the caller supplied the reference date. */
  explicit: boolean;
}

export class ReferenceDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceDateError";
  }
}

/** Effective-date sources (mig080) that describe the content, not the row. */
const CONTENT_DATE_SOURCES: ReadonlySet<string> = new Set(["date", "event_date", "published", "filename"]);

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** MEMRAIN_TIMEZONE when it names a real IANA zone, else UTC. */
export function thinkTimeZone(raw: string | undefined = process.env.MEMRAIN_TIMEZONE): string {
  const zone = (raw ?? "").trim();
  return zone.length > 0 && isValidTimeZone(zone) ? zone : "UTC";
}

/** The calendar day an instant falls on in `timeZone`, as YYYY-MM-DD. */
export function dayInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Validate a caller-supplied reference date: a real YYYY-MM-DD calendar day no
 * later than tomorrow in `timeZone` (one day of slack covers a caller whose
 * clock runs ahead of the brain's zone).
 */
export function parseReferenceDate(raw: string, timeZone: string, now: Date = new Date()): string {
  const value = raw.trim();
  const m = ISO_DAY.exec(value);
  if (!m) throw new ReferenceDateError(`reference_date must be YYYY-MM-DD (got "${value.slice(0, 40)}").`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    throw new ReferenceDateError(`reference_date is not a real calendar date: "${value}".`);
  }
  const tomorrow = dayInZone(new Date(now.getTime() + 86_400_000), timeZone);
  if (value > tomorrow) {
    throw new ReferenceDateError(
      `reference_date ${value} is in the future (today is ${dayInZone(now, timeZone)} in ${timeZone}).`,
    );
  }
  return value;
}

export function resolveThinkTemporalContext(
  opts: { referenceDate?: string; now?: Date; timeZone?: string } = {},
): ThinkTemporalContext {
  const timeZone = opts.timeZone ?? thinkTimeZone();
  const now = opts.now ?? new Date();
  if (opts.referenceDate !== undefined) {
    return { referenceDate: parseReferenceDate(opts.referenceDate, timeZone, now), timeZone, explicit: true };
  }
  return { referenceDate: dayInZone(now, timeZone), timeZone, explicit: false };
}

/**
 * The content date of a document as YYYY-MM-DD, or null. A value stored at
 * exactly midnight UTC is a day-only frontmatter date and renders as written;
 * any other instant renders in `timeZone`.
 */
export function pageContentDate(
  effectiveDate: string | Date | null | undefined,
  source: string | null | undefined,
  timeZone: string,
): string | null {
  if (!source || !CONTENT_DATE_SOURCES.has(source)) return null;
  if (effectiveDate === null || effectiveDate === undefined || effectiveDate === "") return null;
  if (typeof effectiveDate === "string" && ISO_DAY.test(effectiveDate.trim())) return effectiveDate.trim();
  const instant = effectiveDate instanceof Date ? effectiveDate : new Date(effectiveDate);
  if (!Number.isFinite(instant.getTime())) return null;
  if (
    instant.getUTCHours() === 0 &&
    instant.getUTCMinutes() === 0 &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0
  ) {
    return instant.toISOString().slice(0, 10);
  }
  return dayInZone(instant, timeZone);
}
