/**
 * Pushed-down retrieval filters — lang / symbol_kind / since / until predicates
 * folded into the keyword (ts_rank_cd) and vector (pgvector) SQL WHERE clauses.
 *
 * Applying these at the SQL layer (rather than post-hydrate over the fanout
 * candidate pool) means the per-arm LIMIT budget is spent on rows that already
 * match: a filtered query whose matches rank below the fanout no longer returns
 * fewer than k (or zero) when matching content exists.
 *
 * since/until bound the SAME content-date axis the ranking uses —
 * COALESCE(effective_date, updated_at) — cast to timestamptz so the compare is
 * temporal, never a lexical string compare across the "…T…" vs "… …+00" gap.
 */
import { OperationError } from "../operation-error.ts";
import { validateSlugPrefix } from "../pages.ts";
import { PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL } from "../page-index.ts";
import { isTrustTier, minTrustClause, pageRankSql, TRUST_TIERS, trustRank, type TrustTier } from "../trust-tier.ts";

export interface PageFilters {
  types?: readonly string[];
  slugPrefix?: string;
  /**
   * Keep rows whose effective trust tier is at least this one. Every arm that
   * takes page filters applies it before its own LIMIT, so a lower-tier row
   * never takes a slot an eligible row could fill.
   */
  minTrust?: TrustTier;
}

export function validatePageFilters(f: PageFilters): void {
  if (f.types !== undefined && (!Array.isArray(f.types) || f.types.length > 20 ||
      f.types.some(t => typeof t !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(t)))) {
    throw new OperationError("invalid_params", "types must contain at most 20 lower-case page type names.",
      "Use names such as person, note or meeting; each name must have at most 64 characters.");
  }
  validateSlugPrefix(f.slugPrefix);
  if (f.minTrust !== undefined && !isTrustTier(f.minTrust)) {
    throw new OperationError("invalid_params", `min_trust must be one of ${TRUST_TIERS.join(", ")}.`);
  }
}

/** Match canonical live pages, never a similarly named page in another source. */
export function pageFilterClauses(params: unknown[], f: PageFilters | undefined): string {
  if (!f) return "";
  validatePageFilters(f);
  // A document that is no page (an inline index) is judged on its own tier,
  // so the floor sits beside the page lookup rather than inside it.
  const trust = minTrustClause(params, f.minTrust);
  if (!f.types?.length && !f.slugPrefix) return trust;
  const where = ["p.deleted_at IS NULL", "p.source_id = d.source_id",
    `(d.source_path = (${PAGE_MIRROR_PATH_SQL}) OR d.source_path = (${PAGE_TRUTH_PATH_SQL}) OR d.source_path IN (p.slug, p.slug || '.md', p.slug || '.markdown'))`];
  const { minTrust: _floor, ...rows } = f;
  return `${trust} AND EXISTS (SELECT 1 FROM pages p WHERE ${where.join(" AND ")}${pageRowFilterClauses(params, rows)})`;
}

/** Predicate for an existing pages alias p, including alias candidate lookup. */
export function pageRowFilterClauses(params: unknown[], f: PageFilters | undefined): string {
  if (!f) return "";
  validatePageFilters(f);
  let sql = "";
  if (f.types?.length) sql += ` AND p.type = ANY($${params.push([...f.types])}::text[])`;
  if (f.slugPrefix) sql += ` AND p.slug LIKE $${params.push(f.slugPrefix.replace(/([\\%_])/g, "\\$1") + "%")} ESCAPE '\\'`;
  if (f.minTrust !== undefined && f.minTrust !== "external") {
    sql += ` AND (${pageRankSql("p")}) >= $${params.push(trustRank(f.minTrust))}::int`;
  }
  return sql;
}

export interface ChunkFilters extends PageFilters {
  /** chunks.language (e.g. "typescript"). */
  lang?: string;
  /** chunks.symbol_type (e.g. "function"). */
  symbolKind?: string;
  /** Keep docs whose content date is >= this ISO date. */
  since?: string;
  /** Keep docs whose content date is <= this ISO date. */
  until?: string;
}

/** True when at least one filter axis is set. */
export function hasChunkFilters(f: ChunkFilters | undefined): boolean {
  return Boolean(f && (f.lang || f.symbolKind || f.since || f.until || f.types?.length || f.slugPrefix || f.minTrust));
}

const RELATIVE_DURATION = /^(\d+)([dwmy])$/;
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const UNIT_DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/**
 * Normalize a since/until bound to an ISO-8601 timestamp:
 * - relative durations ("7d" / "2w" / "6m" / "1y") subtract from now
 *   (m = 30 days, y = 365 — a lookback window, not calendar arithmetic);
 * - a plain YYYY-MM-DD `until` maps to end-of-day (T23:59:59.999Z) so the
 *   bound includes that whole day instead of cutting at midnight;
 * - anything else Date.parse accepts passes through unchanged.
 * Garbage throws — a silently-dropped bound would widen the result set.
 */
export function resolveDateBoundary(value: string, which: "since" | "until"): string {
  const v = value.trim();
  const rel = RELATIVE_DURATION.exec(v);
  const invalid = () => new OperationError(
    "invalid_params", `Invalid ${which} value "${value}"`,
    "Use ISO-8601 (e.g. 2026-01-15) or a relative duration (7d / 2w / 6m / 1y).",
  );
  if (rel) {
    const days = Number(rel[1]) * UNIT_DAYS[rel[2] as string]!;
    const date = new Date(Date.now() - days * DAY_MS);
    if (!Number.isFinite(date.getTime())) throw invalid();
    return date.toISOString();
  }
  const parsed = Date.parse(v);
  if (!Number.isFinite(parsed)) throw invalid();
  if (PLAIN_DATE.test(v)) {
    if (new Date(parsed).toISOString().slice(0, 10) !== v) throw invalid();
    return `${v}T${which === "until" ? "23:59:59.999" : "00:00:00.000"}Z`;
  }
  return v;
}

/** Legacy numeric hours and the same date/duration syntax as retrieval. */
export function resolveSinceHours(value: string, maxHours: number): number {
  const text = value.trim();
  const numeric = Number(text);
  const hours = text && Number.isFinite(numeric) ? numeric
    : (Date.now() - Date.parse(resolveDateBoundary(text, "since"))) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 1 || hours > maxHours) {
    throw new OperationError("invalid_params", `Invalid since value "${value}"; expected a lookback between 1 and ${maxHours} hours`);
  }
  return hours;
}

/**
 * Append filter predicates to a growing positional-parameter array, returning
 * the SQL fragment (each clause prefixed " AND "). Column refs assume the caller
 * aliases chunks as `c` and documents as `d` — both keyword.ts and vector.ts do.
 * A no-op (empty string, no params pushed) when no axis is set.
 */
export function chunkFilterClauses(params: unknown[], f: ChunkFilters | undefined): string {
  if (!f) return "";
  let sql = "";
  if (f.lang) {
    params.push(f.lang);
    sql += ` AND c.language = $${params.length}`;
  }
  if (f.symbolKind) {
    params.push(f.symbolKind);
    sql += ` AND c.symbol_type = $${params.length}`;
  }
  if (f.since) {
    params.push(resolveDateBoundary(f.since, "since"));
    sql += ` AND COALESCE(d.effective_date, d.updated_at) >= $${params.length}::timestamptz`;
  }
  if (f.until) {
    params.push(resolveDateBoundary(f.until, "until"));
    sql += ` AND COALESCE(d.effective_date, d.updated_at) <= $${params.length}::timestamptz`;
  }
  return sql + pageFilterClauses(params, f);
}
