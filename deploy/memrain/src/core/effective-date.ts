/**
 * Deterministic content-date extraction for `documents.effective_date`.
 *
 * Tries, in order: frontmatter `date` / `event_date` / `published` (string or
 * number), then a `YYYY-MM-DD` prefix in the filename. Returns an ISO string
 * (UTC) or null when nothing parses. Pure, LLM-free, defensive — any malformed
 * value yields null, never a throw, so a bad frontmatter date can't break
 * ingest. The retrieval path falls back to `updated_at` via COALESCE when this
 * is null, so a null result is fully back-compatible.
 */

const FM_DATE_KEYS = ["date", "event_date", "published"] as const;
const FILENAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/**
 * True when a string starting `YYYY-MM-DD` names a real calendar day. The
 * Date parser rolls 2026-02-30 over to March 2 instead of failing.
 */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // PostgreSQL dates have no year zero; JS accepts it as astronomical notation.
  if (year === 0) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** Coerce an arbitrary frontmatter value to an ISO date string, or null. */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  // Number → epoch seconds or ms. Threshold 1e11: epoch SECONDS for any real
  // year are ~1e9 (year 2000 ≈ 9.5e8), epoch MS are ~1e12 (year 2000 ≈ 9.5e11),
  // so 1e11 cleanly separates them and a pre-2001 ms value (≈8.8e11 for 1998)
  // is still correctly read as ms rather than multiplied into the far future.
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isCalendarDate(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Where a resolved effective_date came from (mig080 sentinel).
 * 'fallback' = nothing parsed; the read path COALESCEs to updated_at.
 */
export type EffectiveDateSource =
  | "date"
  | "event_date"
  | "published"
  | "filename"
  | "fallback";

export interface ResolvedEffectiveDate {
  /** ISO-8601 UTC string, or null when nothing parsed ('fallback'). */
  iso: string | null;
  source: EffectiveDateSource;
}

/**
 * Resolve an effective (content) date from a document's frontmatter and path.
 * @returns ISO-8601 UTC string, or null when no date can be parsed.
 */
export function resolveEffectiveDate(
  frontmatter: Record<string, unknown> | null | undefined,
  sourcePath?: string | null,
): string | null {
  return resolveEffectiveDateWithSource(frontmatter, sourcePath).iso;
}

/**
 * As `resolveEffectiveDate`, but also reports WHICH derivation won (the
 * mig080 provenance sentinel the doctor's effective_date_health reads).
 */
export function resolveEffectiveDateWithSource(
  frontmatter: Record<string, unknown> | null | undefined,
  sourcePath?: string | null,
): ResolvedEffectiveDate {
  if (frontmatter) {
    for (const key of FM_DATE_KEYS) {
      const iso = toIso(frontmatter[key]);
      if (iso) return { iso, source: key };
    }
  }
  if (typeof sourcePath === "string") {
    const m = sourcePath.match(FILENAME_DATE_RE);
    if (m) {
      const iso = toIso(`${m[1]}-${m[2]}-${m[3]}`);
      if (iso) return { iso, source: "filename" };
    }
  }
  return { iso: null, source: "fallback" };
}

/** Basename of the ingested path (mig080 `import_filename`), or null. */
export function importFilename(sourcePath?: string | null): string | null {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return null;
  const base = sourcePath.split("/").pop() ?? "";
  return base.length > 0 ? base.slice(0, 512) : null;
}
