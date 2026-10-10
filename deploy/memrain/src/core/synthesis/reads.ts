/**
 * Read-side accessors for synthesized content (migration 045). Back the
 * list_concepts / list_takes / get_calibration_profile MCP tools. Deterministic
 * SELECTs over the synth_* tables; fail-open to empty on a pre-045 brain.
 *
 * These read content the LLM synthesis phases derived FROM the user's notes;
 * they never touch documents/pages. Internal-only at the MCP layer.
 */
import type { Engine } from "../engine/interface.ts";
import { excludeEmptyExtractionTombstone } from "./takes.ts";
import { normalizeScope } from "../source-scope.ts";
import { quarantineFilterFragment } from "../quarantine.ts";

function clampLimit(limit: number | undefined, max: number, dflt: number): number {
  return typeof limit === "number" && limit >= 1 && limit <= max
    ? Math.floor(limit)
    : dflt;
}

/**
 * Normalise a token's takes-holders allow-list (mig 072 knob, enforced since
 * mig 091 added the holder column). `undefined`/empty stays unscoped; a `*`
 * entry is the operator's explicit "all holders" escape hatch.
 */
function normalizeHolderAllowList(holders: string[] | undefined): string[] | undefined {
  if (!Array.isArray(holders) || holders.length === 0) return undefined;
  const cleaned = holders.filter((s) => typeof s === "string" && s.length > 0);
  if (cleaned.length === 0 || cleaned.includes("*")) return undefined;
  return Array.from(new Set(cleaned));
}

/**
 * `AND` clause dropping a take distilled from a quarantined document: content
 * the gate hid from search must not resurface as a claim. A take whose
 * `source_ref` is not a document is unaffected.
 */
function excludeQuarantinedSource(sourceRef: string): string {
  return ` AND NOT EXISTS (SELECT 1 FROM documents qd WHERE qd.id = ${sourceRef} AND NOT (${quarantineFilterFragment("qd")}))`;
}

export interface ConceptRow {
  concept_slug: string;
  title: string;
  tier: string;
  atom_count: number;
  narrative: string;
  generated_at: string;
}

/**
 * `_sourceIds` is accepted for API symmetry with the other scoped reads, but
 * NOT applied: `synth_concepts` is a GLOBAL aggregate — concepts cluster atoms
 * across every source (migration 045 has no `source_id` on the table), so
 * there is no row-level tenant axis to filter on. Passing it is a no-op.
 */
export async function listConcepts(
  engine: Engine,
  limit?: number,
  _sourceIds?: string[],
): Promise<ConceptRow[]> {
  const n = clampLimit(limit, 200, 50);
  try {
    const r = await engine.query<ConceptRow>(
      `SELECT concept_slug, title, tier, atom_count, narrative,
              generated_at::text AS generated_at
         FROM synth_concepts
        ORDER BY atom_count DESC, concept_slug ASC
        LIMIT $1`,
      [n],
    );
    return r.rows;
  } catch {
    return []; // pre-045 brain — synth tables don't exist yet
  }
}

export interface TakeRow {
  take_key: string;
  claim_text: string;
  kind: string;
  /** Who holds the belief: world | brain | people/<slug> | companies/<slug>. */
  holder: string;
  weight: number;
  domain: string | null;
  status: string;
  /** false = superseded/retracted (struck through in the page fence). */
  active: boolean;
  /** Human (or gated auto-resolve) resolution; null while unresolved. */
  resolved_quality: string | null;
  resolved_at: string | null;
  generated_at: string;
}

export const LIST_TAKES_SORTS = ["generated_at", "weight"] as const;
export type ListTakesSort = (typeof LIST_TAKES_SORTS)[number];

export interface ListTakesOptions {
  status?: string;
  /** Filter to one take kind (fact/take/bet/hunch/judgment...). */
  kind?: string;
  /** Filter to one domain tag. */
  domain?: string;
  /** Filter to one holder (exact match). */
  holder?: string;
  /** Filter on lifecycle state; undefined returns both. */
  active?: boolean;
  /** Sort key: `generated_at` (default, newest first) or `weight` (DESC). */
  sort?: ListTakesSort;
  limit?: number;
  /** Skip the first N rows (pagination). */
  offset?: number;
  sourceIds?: string[];
  /** Token-level holder allow-list (mig 072); rows outside it are invisible. */
  holderAllowList?: string[];
}

export async function listTakes(
  engine: Engine,
  opts: ListTakesOptions = {},
): Promise<TakeRow[]> {
  const n = clampLimit(opts.limit, 200, 50);
  const status = typeof opts.status === "string" ? opts.status : null;
  // Takes carry only `source_ref` (the document id they were distilled from,
  // when source_kind='document'); scope by joining that to documents.source_id.
  // A take whose source_ref isn't a document of a listed tenant is excluded
  // fail-closed — the same posture mig 047 takes for unclassified rows.
  const sources = normalizeScope(opts.sourceIds);
  const offset =
    typeof opts.offset === "number" && opts.offset > 0
      ? Math.floor(opts.offset)
      : 0;
  const params: unknown[] = [status, n, offset];
  let extraFilter = "";
  if (typeof opts.kind === "string" && opts.kind.length > 0) {
    params.push(opts.kind);
    extraFilter += ` AND kind = $${params.length}`;
  }
  if (typeof opts.domain === "string" && opts.domain.length > 0) {
    params.push(opts.domain);
    extraFilter += ` AND domain = $${params.length}`;
  }
  if (typeof opts.holder === "string" && opts.holder.length > 0) {
    params.push(opts.holder);
    extraFilter += ` AND holder = $${params.length}`;
  }
  if (typeof opts.active === "boolean") {
    params.push(opts.active);
    extraFilter += ` AND active = $${params.length}`;
  }
  const holderAllowList = normalizeHolderAllowList(opts.holderAllowList);
  if (holderAllowList) {
    params.push(holderAllowList);
    extraFilter += ` AND holder = ANY($${params.length}::text[])`;
  }
  if (sources !== undefined) {
    params.push(sources);
    extraFilter += ` AND EXISTS (
          SELECT 1 FROM documents d
           WHERE d.id = synth_takes.source_ref
             AND d.source_id = ANY($${params.length}::text[])
        )`;
  }
  // Unconditional: the zero-yield memo is not a claim, and this listing spans
  // every lifecycle state, so nothing else keeps it out of an unfiltered read.
  extraFilter += excludeEmptyExtractionTombstone("claim_text", params);
  extraFilter += excludeQuarantinedSource("synth_takes.source_ref");
  // Whitelisted ORDER BY — the enum is the only path into the SQL.
  const order =
    opts.sort === "weight"
      ? "weight DESC, generated_at DESC, take_key ASC"
      : "generated_at DESC, take_key ASC";
  try {
    const r = await engine.query<TakeRow>(
      `SELECT take_key, claim_text, kind, holder, weight, domain, status, active,
              resolved_quality, resolved_at::text AS resolved_at,
              generated_at::text AS generated_at
         FROM synth_takes
        WHERE ($1::text IS NULL OR status = $1)${extraFilter}
        ORDER BY ${order}
        LIMIT $2 OFFSET $3`,
      params,
    );
    return r.rows;
  } catch {
    return [];
  }
}

export interface TakeSearchRow {
  take_key: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  status: string;
}

/**
 * Fuzzy claim search over `synth_takes`. Ranks by pg_trgm `similarity()` and
 * falls back to a substring match so a short query still recalls its exact
 * phrase. Uses the `similarity()` FUNCTION with an explicit threshold rather
 * than the `%` operator, since there is no trigram GIN index to back the
 * operator (same choice as slug resolution). Tenant scope mirrors `listTakes`:
 * a scoped caller only sees takes whose source document is one of theirs,
 * fail-closed. Fail-open to empty on a pre-045 brain.
 */
export async function searchTakes(
  engine: Engine,
  opts: { q: string; limit?: number; sourceIds?: string[]; holderAllowList?: string[] },
): Promise<TakeSearchRow[]> {
  const q = typeof opts.q === "string" ? opts.q.trim() : "";
  if (q.length === 0) return [];
  const n = clampLimit(opts.limit, 200, 50);
  const sources = normalizeScope(opts.sourceIds);
  const params: unknown[] = [q, n];
  let sourceFilter = "";
  const holderAllowList = normalizeHolderAllowList(opts.holderAllowList);
  if (holderAllowList) {
    params.push(holderAllowList);
    sourceFilter += ` AND holder = ANY($${params.length}::text[])`;
  }
  if (sources !== undefined) {
    params.push(sources);
    sourceFilter += ` AND EXISTS (
          SELECT 1 FROM documents d
           WHERE d.id = synth_takes.source_ref
             AND d.source_id = ANY($${params.length}::text[])
        )`;
  }
  // The sentinel is ordinary prose to a trigram match — fence it by claim text.
  sourceFilter += excludeEmptyExtractionTombstone("claim_text", params);
  sourceFilter += excludeQuarantinedSource("synth_takes.source_ref");
  try {
    const r = await engine.query<TakeSearchRow>(
      `SELECT take_key, claim_text, kind, holder, weight, domain, status
         FROM synth_takes
        WHERE (similarity(claim_text, $1) >= 0.3 OR claim_text ILIKE '%' || $1 || '%')${sourceFilter}
        ORDER BY similarity(claim_text, $1) DESC, take_key ASC
        LIMIT $2`,
      params,
    );
    return r.rows;
  } catch {
    return [];
  }
}

export interface TakesScorecard {
  /** Every take matching the filter (graded or not). */
  total_takes: number;
  /** Takes that carry at least one grade. */
  graded: number;
  /** Graded takes whose latest verdict is correct∨incorrect∨partial. */
  resolved: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  /** correct / (correct + incorrect); null when nothing is decided. */
  accuracy: number | null;
  /** partial / resolved; null when nothing is resolved. */
  partial_rate: number | null;
  /** Mean (weight − outcome)² over decided (correct∨incorrect) bets; null when
   *  none are decided. Lower is better-calibrated. */
  brier: number | null;
}

const EMPTY_SCORECARD: TakesScorecard = {
  total_takes: 0,
  graded: 0,
  resolved: 0,
  correct: 0,
  incorrect: 0,
  partial: 0,
  unresolvable: 0,
  accuracy: null,
  partial_rate: null,
  brier: null,
};

/**
 * Calibration scorecard over `synth_takes` × their LATEST `synth_take_grades`
 * row (DISTINCT ON take_id, newest grade wins — re-grading with new evidence
 * appends a row). The take's OWN resolution tuple wins over the judge grade
 * (mig 090): once a human (or gated auto-resolve) resolves a take, calibration
 * measures that verdict, and the judge grade stays advisory. Counts, accuracy,
 * partial-rate, and Brier are all pure SQL — no LLM. Tenant scope mirrors
 * `listTakes`: a scoped caller only sees takes whose source document is one of
 * theirs (fail-closed via the documents join). Fail-open to a zero scorecard
 * on a pre-045 brain.
 */
export async function getTakesScorecard(
  engine: Engine,
  opts: {
    domain?: string;
    holder?: string;
    since?: string;
    until?: string;
    sourceIds?: string[];
    holderAllowList?: string[];
  } = {},
): Promise<TakesScorecard> {
  const sources = normalizeScope(opts.sourceIds);
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (typeof opts.domain === "string" && opts.domain.length > 0) {
    params.push(opts.domain);
    clauses.push(`AND t.domain = $${params.length}`);
  }
  // Explicit holder filter — ANDs with the token allow-list below (fail-closed:
  // asking for a holder outside the allow-list yields zero, never a bypass).
  if (typeof opts.holder === "string" && opts.holder.length > 0) {
    params.push(opts.holder);
    clauses.push(`AND t.holder = $${params.length}`);
  }
  // since/until window the take's synthesis date (memrain has no per-take
  // belief-as-of date column).
  if (typeof opts.since === "string" && opts.since.length > 0) {
    params.push(opts.since);
    clauses.push(`AND t.generated_at::date >= $${params.length}::date`);
  }
  if (typeof opts.until === "string" && opts.until.length > 0) {
    params.push(opts.until);
    clauses.push(`AND t.generated_at::date <= $${params.length}::date`);
  }
  const holderAllowList = normalizeHolderAllowList(opts.holderAllowList);
  if (holderAllowList) {
    params.push(holderAllowList);
    clauses.push(`AND t.holder = ANY($${params.length}::text[])`);
  }
  if (sources !== undefined) {
    params.push(sources);
    clauses.push(
      `AND EXISTS (SELECT 1 FROM documents d WHERE d.id = t.source_ref AND d.source_id = ANY($${params.length}::text[]))`,
    );
  }
  // total_takes counts every take regardless of lifecycle, so the memo would
  // otherwise inflate the denominator behind accuracy and grade completion.
  const where =
    clauses.join(" ") +
    excludeEmptyExtractionTombstone("t.claim_text", params) +
    excludeQuarantinedSource("t.source_ref");
  try {
    const r = await engine.query<{
      total_takes: number;
      graded: number;
      resolved: number;
      correct: number;
      incorrect: number;
      partial: number;
      unresolvable: number;
      brier: number | null;
    }>(
      `WITH latest_grade AS (
         SELECT DISTINCT ON (take_id) take_id, verdict
           FROM synth_take_grades
          ORDER BY take_id, generated_at DESC
       ),
       scored AS (
         SELECT t.weight,
                lg.verdict AS grade_verdict,
                COALESCE(t.resolved_quality, lg.verdict) AS verdict
           FROM synth_takes t
           LEFT JOIN latest_grade lg ON lg.take_id = t.id
          WHERE 1=1 ${where}
       )
       SELECT
         COUNT(*)::int                                                            AS total_takes,
         COUNT(grade_verdict)::int                                                AS graded,
         COUNT(*) FILTER (WHERE verdict IN ('correct','incorrect','partial'))::int AS resolved,
         COUNT(*) FILTER (WHERE verdict = 'correct')::int                         AS correct,
         COUNT(*) FILTER (WHERE verdict = 'incorrect')::int                       AS incorrect,
         COUNT(*) FILTER (WHERE verdict = 'partial')::int                         AS partial,
         COUNT(*) FILTER (WHERE verdict = 'unresolvable')::int                    AS unresolvable,
         AVG(CASE WHEN verdict IN ('correct','incorrect')
                  THEN POWER(weight - (CASE verdict WHEN 'correct' THEN 1 ELSE 0 END), 2)
             END)::float                                                          AS brier
         FROM scored`,
      params,
    );
    const row = r.rows[0];
    if (!row) return { ...EMPTY_SCORECARD };
    const decided = row.correct + row.incorrect;
    return {
      total_takes: row.total_takes,
      graded: row.graded,
      resolved: row.resolved,
      correct: row.correct,
      incorrect: row.incorrect,
      partial: row.partial,
      unresolvable: row.unresolvable,
      accuracy: decided > 0 ? row.correct / decided : null,
      partial_rate: row.resolved > 0 ? row.partial / row.resolved : null,
      brier: row.brier,
    };
  } catch {
    return { ...EMPTY_SCORECARD };
  }
}

export interface CalibrationBucket {
  bucket_lo: number;
  bucket_hi: number;
  /** Decided bets whose weight fell in this bucket. */
  n: number;
  /** Observed hit-rate (AVG of verdict='correct'); null for an empty bucket. */
  observed: number | null;
  /** Predicted rate (AVG stated weight); null for an empty bucket. */
  predicted: number | null;
}

/**
 * Reliability-diagram data: decided (correct∨incorrect) takes binned by their
 * stated `weight`, observed hit-rate vs predicted (mean weight) per bucket. The
 * curve behind the scorecard's Brier. NUMERIC casts keep bucket boundaries exact
 * at FP-edge weights (e.g. 0.7/0.1). Same tenant scope as `getTakesScorecard`.
 * Fail-open to [] on a pre-045 brain.
 */
export async function getTakesCalibration(
  engine: Engine,
  opts: {
    bucketSize?: number;
    domain?: string;
    holder?: string;
    sourceIds?: string[];
    holderAllowList?: string[];
  } = {},
): Promise<CalibrationBucket[]> {
  const bucketSize =
    typeof opts.bucketSize === "number" && opts.bucketSize > 0 && opts.bucketSize <= 1
      ? opts.bucketSize
      : 0.1;
  const maxIdx = Math.floor(1 / bucketSize) - 1;
  const sources = normalizeScope(opts.sourceIds);
  const params: unknown[] = [bucketSize, maxIdx];
  const clauses: string[] = [];
  if (typeof opts.domain === "string" && opts.domain.length > 0) {
    params.push(opts.domain);
    clauses.push(`AND t.domain = $${params.length}`);
  }
  // Explicit holder filter — ANDs with the token allow-list (fail-closed).
  if (typeof opts.holder === "string" && opts.holder.length > 0) {
    params.push(opts.holder);
    clauses.push(`AND t.holder = $${params.length}`);
  }
  const holderAllowList = normalizeHolderAllowList(opts.holderAllowList);
  if (holderAllowList) {
    params.push(holderAllowList);
    clauses.push(`AND t.holder = ANY($${params.length}::text[])`);
  }
  if (sources !== undefined) {
    params.push(sources);
    clauses.push(
      `AND EXISTS (SELECT 1 FROM documents d WHERE d.id = t.source_ref AND d.source_id = ANY($${params.length}::text[]))`,
    );
  }
  const where = clauses.join(" ") + excludeQuarantinedSource("t.source_ref");
  try {
    const r = await engine.query<{
      bucket_lo: number;
      bucket_hi: number;
      n: number;
      observed: number | null;
      predicted: number | null;
    }>(
      `WITH latest_grade AS (
         SELECT DISTINCT ON (take_id) take_id, verdict
           FROM synth_take_grades
          ORDER BY take_id, generated_at DESC
       ),
       binned AS (
         SELECT LEAST(FLOOR(t.weight::numeric / $1::numeric)::int, $2::int)::int AS bucket_idx,
                t.weight,
                (COALESCE(t.resolved_quality, lg.verdict) = 'correct')::int AS hit
           FROM synth_takes t
           LEFT JOIN latest_grade lg ON lg.take_id = t.id
          WHERE COALESCE(t.resolved_quality, lg.verdict) IN ('correct','incorrect') ${where}
       )
       SELECT (bucket_idx::numeric * $1::numeric)::float        AS bucket_lo,
              ((bucket_idx + 1)::numeric * $1::numeric)::float  AS bucket_hi,
              COUNT(*)::int                                     AS n,
              AVG(hit)::float                                   AS observed,
              AVG(weight)::float                                AS predicted
         FROM binned
        GROUP BY bucket_idx
        ORDER BY bucket_idx`,
      params,
    );
    return r.rows.map((b) => ({
      bucket_lo: b.bucket_lo,
      bucket_hi: b.bucket_hi,
      n: b.n,
      observed: b.n > 0 ? b.observed : null,
      predicted: b.n > 0 ? b.predicted : null,
    }));
  } catch {
    return [];
  }
}

export interface CalibrationProfileRow {
  generated_at: string;
  source_id: string;
  total_graded: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  accuracy: number | null;
  /** Mean (weight − outcome)² over decided bets (mig 069); null pre-069. */
  brier: number | null;
  /** partial / resolved (mig 069); null pre-069. */
  partial_rate: number | null;
  /** Graded / total takes for the tenant (mig 069); defaults 1.0. */
  grade_completion: number | null;
  /** Per-domain scorecards keyed by take domain (mig 069); {} pre-069. */
  domain_scorecards: unknown;
  pattern_statements: unknown;
  bias_tags: unknown;
  model_id: string;
}

/**
 * Latest calibration profile the caller is allowed to see. Migration 060 added
 * the `source_id` axis, so profiles are per-tenant: a scoped caller filters to
 * their effective read source set (`source_id = ANY($allowed)`), which excludes
 * every other tenant's profile fail-closed — the same posture the other scoped
 * reads take. An empty scope sees no profile; `undefined` leaves it unscoped
 * (admin/internal), returning the newest profile across all tenants.
 */
export async function getCalibrationProfile(
  engine: Engine,
  sourceIds?: string[],
): Promise<CalibrationProfileRow | null> {
  const sources = normalizeScope(sourceIds);
  const params: unknown[] = [];
  let sourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    sourceFilter = ` WHERE source_id = ANY($${params.length}::text[])`;
  }
  try {
    const r = await engine.query<CalibrationProfileRow>(
      `SELECT generated_at::text AS generated_at, source_id, total_graded, correct,
              incorrect, partial, unresolvable, accuracy,
              brier, partial_rate, grade_completion, domain_scorecards,
              pattern_statements, bias_tags, model_id
         FROM synth_calibration_profile${sourceFilter}
        ORDER BY generated_at DESC
        LIMIT 1`,
      params,
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}
