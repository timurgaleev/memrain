/**
 * eval-replay — regression harness for real captured queries.
 *
 * Two phases:
 *   1. CAPTURE — `recordQuery` persists a (query, k, expected_doc_id?,
 *      tag) row. Tags come from the user marking a recall result as
 *      'good' (the answer was correct) or 'bad' (it wasn't), typically
 *      from inside chat. Bad rows still ship into the eval set so we
 *      catch known-wrong queries when ranking changes.
 *   2. REPLAY — `replayAll` re-runs each query against the live brain,
 *      compares to the persisted baseline, and surfaces deltas. Pass
 *      `promote: true` to overwrite the baseline with the latest run.
 *
 * Metrics per query:
 *   - hit: did `expected_doc_id` show up in the top-k?
 *   - rank: 1-based rank of the expected doc, or null
 *   - rr (reciprocal rank): 1/rank if hit, 0 if not, null if no expected
 *
 * Aggregate:
 *   - meanRR over queries that have an expected doc
 *   - hitRate over queries that have an expected doc
 *   - perQuery deltas for the report
 *   - unscored: queries without an expected doc, counted on their own
 *
 * Replay walks the set in id order, so a limit selects the same queries every
 * run; `replayedIdsSha256` names that set.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { hybridSearch, type SearchOptions } from "./search/hybrid.ts";
import { keywordSearch } from "./search/keyword.ts";
import { distinctInOrder, jaccardAtK, top1Stable } from "./search/metrics.ts";
import { ci95, deltaCi95, type Ci95 } from "./search/bootstrap.ts";

export type EvalTag = "good" | "bad";
export type EvalSearchMode = "hybrid" | "keyword";

export interface EvalQueryRow {
  id: string;
  capturedAt: Date;
  query: string;
  k: number;
  expectedDocId: string | null;
  tag: EvalTag;
  source: string;
  notes: string | null;
  searchMode: EvalSearchMode;
  baselineDocIds: string[] | null;
  baselineRank: number | null;
  baselineHit: boolean | null;
  baselineRr: number | null;
  baselineRanAt: Date | null;
}

export interface RecordQueryInput {
  id: string;
  query: string;
  tag: EvalTag;
  k?: number;
  expectedDocId?: string;
  source?: string;
  notes?: string;
  searchMode?: EvalSearchMode;
}

export interface RunResult {
  queryId: string;
  query: string;
  tag: EvalTag;
  expectedDocId: string | null;
  resultDocIds: string[];
  hit: boolean | null;
  rank: number | null;
  rr: number | null;
  durationMs: number;
  delta: {
    hit: number | null;
    rank: number | null;
    rr: number | null;
  } | null;
  /** Run-to-run stability vs the persisted baseline (null if no baseline).
   *  jaccard = top-k set overlap; top1 = same rank-1 doc. Independent of
   *  expected_doc_id, so it scores every query that has a baseline. */
  stability: { jaccard: number; top1: boolean } | null;
}

export interface ReplayReport {
  ok: boolean;
  ranAt: string;
  totalQueries: number;
  scored: number;
  meanRR: number;
  hitRate: number;
  /** Seeded bootstrap intervals over the scored queries. */
  meanRRCi95: Ci95;
  hitRateCi95: Ci95;
  /** sha256 of the replayed query ids, sorted: two runs (or two snapshots)
   *  compare like with like only when this matches. */
  replayedIdsSha256: string;
  /** Queries without an expected doc: outside meanRR and hitRate, counted
   *  here so the averages' n is never silently smaller than the run. */
  unscored: {
    count: number;
    /** Of those, how many came back with at least one result. */
    returnedAny: number;
  };
  baseline?: {
    /** Queries that have both a baseline and a current score. Every field
     *  below is over this subset, so a query captured after the last
     *  --promote never moves the delta or the gate. */
    paired: number;
    meanRR: number;
    hitRate: number;
    deltaMeanRR: number;
    deltaHitRate: number;
    /** Paired intervals over the queries that have a baseline. */
    deltaMeanRRCi95: Ci95;
    deltaHitRateCi95: Ci95;
    /** The MRR delta interval lies entirely below 0: a drop beyond noise. */
    significantDrop: boolean;
  };
  /** Aggregate run-to-run stability over queries that have a baseline. */
  stability?: {
    scored: number;
    meanJaccard: number;
    top1StableRate: number;
  };
  perQuery: RunResult[];
}

interface RawEvalRow {
  id: string;
  captured_at: string | Date;
  query: string;
  k: number;
  expected_doc_id: string | null;
  tag: EvalTag;
  source: string;
  notes: string | null;
  search_mode: EvalSearchMode;
  baseline_doc_ids: string | string[] | null;
  baseline_rank: number | null;
  baseline_hit: boolean | null;
  baseline_rr: string | number | null;
  baseline_ran_at: string | Date | null;
}

const SELECT_COLS =
  "id, captured_at, query, k, expected_doc_id, tag, source, notes, search_mode, " +
  "baseline_doc_ids, baseline_rank, baseline_hit, baseline_rr, baseline_ran_at";

function rowToEval(r: RawEvalRow): EvalQueryRow {
  let baselineDocIds: string[] | null = null;
  if (r.baseline_doc_ids !== null && r.baseline_doc_ids !== undefined) {
    if (typeof r.baseline_doc_ids === "string") {
      try {
        const p = JSON.parse(r.baseline_doc_ids);
        baselineDocIds = Array.isArray(p) ? p : null;
      } catch {
        baselineDocIds = null;
      }
    } else if (Array.isArray(r.baseline_doc_ids)) {
      baselineDocIds = r.baseline_doc_ids;
    }
  }
  return {
    id: r.id,
    capturedAt: r.captured_at instanceof Date ? r.captured_at : new Date(r.captured_at),
    query: r.query,
    k: r.k,
    expectedDocId: r.expected_doc_id,
    tag: r.tag,
    source: r.source,
    notes: r.notes,
    searchMode: r.search_mode ?? "hybrid",
    baselineDocIds,
    baselineRank: r.baseline_rank,
    baselineHit: r.baseline_hit,
    baselineRr: r.baseline_rr === null ? null : Number(r.baseline_rr),
    baselineRanAt:
      r.baseline_ran_at === null
        ? null
        : r.baseline_ran_at instanceof Date
          ? r.baseline_ran_at
          : new Date(r.baseline_ran_at),
  };
}

export async function recordQuery(
  engine: Engine,
  input: RecordQueryInput,
): Promise<EvalQueryRow> {
  if (!input.id) throw new Error("recordQuery: id is required");
  if (!input.query?.trim()) throw new Error("recordQuery: query is required");
  if (input.tag !== "good" && input.tag !== "bad") {
    throw new Error(`recordQuery: tag must be 'good' or 'bad' (got ${input.tag})`);
  }
  const k = input.k ?? 5;
  if (!Number.isInteger(k) || k < 1 || k > 100) {
    throw new Error(`recordQuery: k must be 1-100 (got ${k})`);
  }
  const searchMode: EvalSearchMode = input.searchMode ?? "hybrid";
  if (searchMode !== "hybrid" && searchMode !== "keyword") {
    throw new Error(`recordQuery: searchMode must be hybrid|keyword (got ${searchMode})`);
  }
  const r = await engine.query<RawEvalRow>(
    `INSERT INTO eval_queries (id, query, k, expected_doc_id, tag, source, notes, search_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
       SET query = EXCLUDED.query,
           k = EXCLUDED.k,
           expected_doc_id = EXCLUDED.expected_doc_id,
           tag = EXCLUDED.tag,
           source = EXCLUDED.source,
           notes = EXCLUDED.notes,
           search_mode = EXCLUDED.search_mode
     RETURNING ${SELECT_COLS}`,
    [
      input.id,
      input.query.trim(),
      k,
      input.expectedDocId ?? null,
      input.tag,
      input.source ?? "manual",
      input.notes ?? null,
      searchMode,
    ],
  );
  if (!r.rows[0]) throw new Error("recordQuery: insert returned no row");
  return rowToEval(r.rows[0]);
}

export async function getQuery(
  engine: Engine,
  id: string,
): Promise<EvalQueryRow | null> {
  const r = await engine.query<RawEvalRow>(
    `SELECT ${SELECT_COLS} FROM eval_queries WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? rowToEval(r.rows[0]) : null;
}

export interface ListOptions {
  tag?: EvalTag;
  limit?: number;
  /** `newest` (default) lists the latest captures first; `id` is the stable
   *  order replay uses, so a limit always selects the same subset. */
  order?: "newest" | "id";
}

export async function listQueries(
  engine: Engine,
  opts: ListOptions = {},
): Promise<EvalQueryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const params: unknown[] = [];
  let where = "";
  if (opts.tag) {
    params.push(opts.tag);
    where = `WHERE tag = $${params.length}`;
  }
  params.push(limit);
  const orderBy =
    opts.order === "id" ? `id COLLATE "C"` : `captured_at DESC, id COLLATE "C" DESC`;
  const r = await engine.query<RawEvalRow>(
    `SELECT ${SELECT_COLS} FROM eval_queries ${where} ORDER BY ${orderBy} LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(rowToEval);
}

/** Rows in the eval set (optionally one tag), whatever a replay's limit. */
export async function countQueries(engine: Engine, tag?: EvalTag): Promise<number> {
  const r = await engine.query<{ n: number }>(
    tag
      ? `SELECT count(*)::int AS n FROM eval_queries WHERE tag = $1`
      : `SELECT count(*)::int AS n FROM eval_queries`,
    tag ? [tag] : [],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Fingerprint of a replayed set: order-independent, one id per line. */
export function replayedIdsHash(ids: string[]): string {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export async function deleteQuery(engine: Engine, id: string): Promise<boolean> {
  const r = await engine.query(`DELETE FROM eval_queries WHERE id = $1`, [id]);
  // PGLite + postgres-js return rows.length=0 from DELETE; check by re-fetch.
  const after = await getQuery(engine, id);
  return after === null && r !== undefined;
}

/**
 * Compute per-query metrics against a list of result documentIds. The rank
 * counts distinct documents: repeated chunks of one document hold one rank.
 * Pure function for unit testing.
 */
export function scoreOne(
  resultDocIds: string[],
  expectedDocId: string | null,
): { hit: boolean | null; rank: number | null; rr: number | null } {
  if (!expectedDocId) return { hit: null, rank: null, rr: null };
  const idx = distinctInOrder(resultDocIds).findIndex((id) => id === expectedDocId);
  if (idx === -1) return { hit: false, rank: null, rr: 0 };
  const rank = idx + 1;
  return { hit: true, rank, rr: 1 / rank };
}

export interface ReplayOptions {
  /** Filter to a single tag. */
  tag?: EvalTag;
  /** Cap on queries replayed. Default 100. */
  limit?: number;
  /**
   * Override the retrieval call (tests pass a stub). The third arg
   * carries the captured row's `searchMode` so the stub can branch.
   */
  searcher?: (
    query: string,
    opts: SearchOptions,
    mode: EvalSearchMode,
  ) => Promise<{ documentId: string }[]>;
  /** Promote each query's new run to the baseline column set. */
  promote?: boolean;
}

/**
 * Default retrieval dispatcher for replayAll. `hybrid` uses
 * `hybridSearch`; `keyword` runs the BM25-style tsvector path and
 * looks up the document_id for each chunk. The keyword path returns
 * chunk IDs natively, so we resolve them to document IDs here for
 * a stable comparison surface against `expected_doc_id`.
 */
async function defaultSearcher(
  storage: Storage,
  query: string,
  opts: SearchOptions,
  mode: EvalSearchMode,
): Promise<{ documentId: string }[]> {
  if (mode === "keyword") {
    const k = opts.k ?? 5;
    const chunkIds = await keywordSearch(storage.engine(), query, k);
    if (chunkIds.length === 0) return [];
    const r = await storage.engine().query<{
      id: string;
      document_id: string;
    }>(
      `SELECT id, document_id FROM chunks WHERE id = ANY($1::text[])`,
      [chunkIds],
    );
    const map = new Map(r.rows.map((row) => [row.id, row.document_id]));
    const out: { documentId: string }[] = [];
    for (const chunkId of chunkIds) {
      const docId = map.get(chunkId);
      if (docId) out.push({ documentId: docId });
    }
    return out;
  }
  return hybridSearch(storage, query, opts);
}

export async function replayAll(
  storage: Storage,
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  const engine = storage.engine();
  const queries = await listQueries(engine, {
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    order: "id",
  });
  const search =
    opts.searcher ??
    ((q: string, o: SearchOptions, m: EvalSearchMode) =>
      defaultSearcher(storage, q, o, m));

  const perQuery: RunResult[] = [];
  let scored = 0;
  let rrSum = 0;
  let hits = 0;
  // Baseline aggregates — only for queries whose expected_doc_id was set.
  let baseScored = 0;
  let baseRrSum = 0;
  let baseHits = 0;
  // Per-query scores for the intervals: every scored query, and the paired
  // (baseline, current) scores of those that have a baseline.
  const rrs: number[] = [];
  const hitFlags: number[] = [];
  const paired = { baseRr: [] as number[], rr: [] as number[], baseHit: [] as number[], hit: [] as number[] };
  // Stability aggregates — for every query that has a persisted baseline.
  let stabScored = 0;
  let jaccardSum = 0;
  let top1Stable_ = 0;
  let unscored = 0;
  let unscoredReturned = 0;

  for (const q of queries) {
    const t0 = Date.now();
    const hits_ = await search(q.query, { k: q.k }, q.searchMode);
    const dur = Date.now() - t0;
    // Several chunks of one document are one result: score documents.
    const ids = distinctInOrder(hits_.map((h) => h.documentId));
    const { hit, rank, rr } = scoreOne(ids, q.expectedDocId);
    let delta: RunResult["delta"] = null;
    if (q.expectedDocId) {
      scored++;
      if (rr !== null) rrSum += rr;
      if (hit) hits++;
      rrs.push(rr ?? 0);
      hitFlags.push(hit ? 1 : 0);
      if (q.baselineRr !== null) {
        baseScored++;
        baseRrSum += q.baselineRr;
        if (q.baselineHit) baseHits++;
        paired.baseRr.push(q.baselineRr);
        paired.rr.push(rr ?? 0);
        paired.baseHit.push(q.baselineHit ? 1 : 0);
        paired.hit.push(hit ? 1 : 0);
        delta = {
          hit:
            q.baselineHit === null
              ? null
              : (hit === true ? 1 : 0) - (q.baselineHit === true ? 1 : 0),
          rank:
            rank === null || q.baselineRank === null
              ? null
              : rank - q.baselineRank,
          rr: (rr ?? 0) - q.baselineRr,
        };
      }
    } else {
      unscored++;
      if (ids.length > 0) unscoredReturned++;
    }
    let stability: RunResult["stability"] = null;
    if (q.baselineDocIds !== null) {
      const jaccard = jaccardAtK(q.baselineDocIds, ids, q.k);
      const top1 = top1Stable(q.baselineDocIds, ids);
      stability = { jaccard: round4(jaccard), top1 };
      stabScored++;
      jaccardSum += jaccard;
      if (top1) top1Stable_++;
    }
    perQuery.push({
      queryId: q.id,
      query: q.query,
      tag: q.tag,
      expectedDocId: q.expectedDocId,
      resultDocIds: ids,
      hit,
      rank,
      rr,
      durationMs: dur,
      delta,
      stability,
    });
    if (opts.promote && q.expectedDocId) {
      await engine.query(
        `UPDATE eval_queries
            SET baseline_doc_ids = $2::text::jsonb,
                baseline_rank = $3,
                baseline_hit = $4,
                baseline_rr = $5,
                baseline_ran_at = NOW()
          WHERE id = $1`,
        [q.id, JSON.stringify(ids), rank, hit, rr],
      );
    }
  }

  const meanRR = scored === 0 ? 0 : rrSum / scored;
  const hitRate = scored === 0 ? 0 : hits / scored;
  const report: ReplayReport = {
    ok: true,
    ranAt: new Date().toISOString(),
    totalQueries: queries.length,
    scored,
    meanRR: round4(meanRR),
    hitRate: round4(hitRate),
    meanRRCi95: ci95(rrs),
    hitRateCi95: ci95(hitFlags),
    replayedIdsSha256: replayedIdsHash(queries.map((q) => q.id)),
    unscored: { count: unscored, returnedAny: unscoredReturned },
    perQuery,
  };
  if (baseScored > 0) {
    const baseMeanRR = baseRrSum / baseScored;
    const baseHitRate = baseHits / baseScored;
    // The point delta and its interval must describe the same queries: the
    // current side is re-averaged over the paired subset, not the full run.
    const pairedMeanRR = paired.rr.reduce((a, b) => a + b, 0) / baseScored;
    const pairedHitRate = paired.hit.reduce((a, b) => a + b, 0) / baseScored;
    const rrDeltaCi = deltaCi95(paired.baseRr, paired.rr);
    report.baseline = {
      paired: baseScored,
      meanRR: round4(baseMeanRR),
      hitRate: round4(baseHitRate),
      deltaMeanRR: round4(pairedMeanRR - baseMeanRR),
      deltaHitRate: round4(pairedHitRate - baseHitRate),
      deltaMeanRRCi95: rrDeltaCi,
      deltaHitRateCi95: deltaCi95(paired.baseHit, paired.hit),
      significantDrop: rrDeltaCi.hi < 0,
    };
  }
  if (stabScored > 0) {
    report.stability = {
      scored: stabScored,
      meanJaccard: round4(jaccardSum / stabScored),
      top1StableRate: round4(top1Stable_ / stabScored),
    };
  }
  return report;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
