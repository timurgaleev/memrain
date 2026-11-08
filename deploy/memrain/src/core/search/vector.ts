/**
 * Vector retrieval — pure pgvector cosine similarity.
 *
 * Returns chunk_ids ordered by distance ascending (closer = better).
 * Both PGLite and Postgres support `<=>` cosine operator from pgvector.
 */
import type { Engine } from "../engine/interface.ts";
import { hnswEfSearchFor } from "../vector-index.ts";
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";
import {
  buildCurationBoostCaseSql,
  buildHardExcludeClauseSql,
} from "./curation.ts";

export interface VectorSearchOptions {
  /** Optional source-id filter — only return chunks whose parent doc
   *  belongs to one of these sources. Default: no filter. */
  sourceIds?: readonly string[];
  /**
   * Pushed-down lang / symbol_kind / since / until predicates. Folded into the
   * WHERE clause so the ANN LIMIT budget is spent on rows that already match.
   * See filters.ts.
   */
  filters?: ChunkFilters;
  /**
   * Per-page max-pool (opt-in, default OFF): collapse to ONE row per
   * (source, document) — the page's NEAREST chunk — BEFORE the LIMIT cut, so
   * the ANN budget returns N distinct pages (each by its closest chunk) instead
   * of N chunks that collapse to fewer pages downstream. This is the arm that
   * historically lacked the pooling the keyword arm always had. See hybrid.ts.
   */
  maxPool?: boolean;
  /**
   * Curation prefix boost inside the arm SQL: rank by
   * boosted cosine similarity `(1 - dist) × factor` so a curated page's chunk
   * survives the ANN LIMIT over bulk-feed noise. Disabled by the caller for
   * temporal queries. Default OFF preserves the pure-distance ordering.
   */
  sourceBoost?: boolean;
  /**
   * Called when a filtered, index-served scan returned fewer than `limit`
   * rows although more matching rows exist: the HNSW candidate budget ran out
   * inside the filter, so the arm is incomplete rather than the corpus small.
   */
  onCandidatesIncomplete?: () => void;
}

/** Tuples one iterative HNSW scan may visit before giving up (pgvector's default is 20000). */
export const HNSW_MAX_SCAN_TUPLES = 40_000;

/** pgvector 0.8 added iterative index scans (`hnsw.iterative_scan`). */
export function pgvectorSupportsIterativeScan(version: string | null): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 8;
}

export interface VectorScanPlan {
  kind: Engine["kind"];
  /** Installed pgvector version, null when unknown. */
  pgvector: string | null;
  /** A source or chunk filter narrows the scan. */
  filtered: boolean;
  /** The query orders by raw distance, so the HNSW index can serve it. */
  indexServed: boolean;
  limit: number;
}

/**
 * The transaction-local settings one vector query runs under ({} = none).
 * Postgres only: PGLite is single-connection, where the wrapping transaction
 * would alias concurrent in-process queries. Only an index-served ordering
 * gains anything — the boosted and max-pool variants are exact scans. Hybrid
 * search asks for the source boost on every non-temporal query, and the boost
 * CASE is never empty, so from hybrid only temporal queries get here; direct
 * `vectorSearch` callers without a boost do too.
 *
 *   - `hnsw.ef_search`: the scan gathers at most this many rows (default 40)
 *     before the LIMIT, so a larger fanout is raised to match.
 *   - `hnsw.iterative_scan` (pgvector >= 0.8, filtered scans only): a filter
 *     applied after the index scan can discard most of those rows and starve
 *     the LIMIT; an iterative scan keeps reading the graph until the LIMIT is
 *     met or `hnsw.max_scan_tuples` is spent. `relaxed_order` is the cheap
 *     mode; the query re-sorts its rows, so the output order stays exact.
 */
export function vectorScanSettings(plan: VectorScanPlan): Record<string, string> {
  if (plan.kind !== "postgres" || !plan.indexServed) return {};
  const out: Record<string, string> = {};
  const ef = hnswEfSearchFor(plan.limit);
  if (ef > 40) out["hnsw.ef_search"] = String(ef);
  if (plan.filtered && pgvectorSupportsIterativeScan(plan.pgvector)) {
    out["hnsw.iterative_scan"] = "relaxed_order";
    out["hnsw.max_scan_tuples"] = String(HNSW_MAX_SCAN_TUPLES);
  }
  return out;
}

const pgvectorVersions = new WeakMap<Engine, Promise<string | null>>();

/** The installed pgvector version, read once per engine. Never throws. */
function pgvectorVersion(engine: Engine): Promise<string | null> {
  let v = pgvectorVersions.get(engine);
  if (v === undefined) {
    v = engine
      .query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
      .then((r) => r.rows[0]?.extversion ?? null)
      .catch(() => {
        // A failed read is not an answer: the next search asks again, or one
        // connection blip would leave iterative scan off until a restart.
        pgvectorVersions.delete(engine);
        return null;
      });
    pgvectorVersions.set(engine, v);
  }
  return v;
}

export async function vectorSearch(
  engine: Engine,
  queryVector: number[],
  limit: number,
  opts: VectorSearchOptions = {},
): Promise<string[]> {
  // `undefined` is unscoped (operator, CLI, every pre-tenancy caller). An
  // EMPTY array is a caller granted nothing: the predicate still goes on and
  // `= ANY('{}')` matches no row. Collapsing the two — `opts.sourceIds ?? []`
  // plus a length check — handed the caller with no grant the whole brain.
  const sourceIds = opts.sourceIds;
  const vis = visibilityClause("d");
  // Join chunks→documents so the visibility filter applies to the ANN arm too.
  // Exclusions (deleted/archived/quarantined) are rare, so the filtered scan
  // barely dents recall; correctness (never surfacing hidden docs) wins.
  // Default hard-excludes are pushed into the WHERE (see curation.ts).
  const excludeClause = buildHardExcludeClauseSql("d.source_path");
  const whereFor = (ps: unknown[]): { sql: string; filtered: boolean } => {
    let sourceFilter = "";
    if (sourceIds !== undefined) {
      ps.push(sourceIds);
      sourceFilter = ` AND d.source_id = ANY($${ps.length}::text[])`;
    }
    const filterClauses = chunkFilterClauses(ps, opts.filters);
    return {
      sql: `${vis}${sourceFilter}${filterClauses}${excludeClause}`,
      filtered: sourceIds !== undefined || filterClauses !== "",
    };
  };
  const params: unknown[] = [JSON.stringify(queryVector)];
  const { sql: where, filtered } = whereFor(params);
  const boostCase = opts.sourceBoost ? buildCurationBoostCaseSql("d.source_path") : null;
  params.push(limit);
  const limitParam = `$${params.length}`;
  // Per-page max-pool (opt-in): pool to the NEAREST chunk per (source, document)
  // BEFORE the LIMIT. Distance ascends (closer = better), so the inner
  // DISTINCT ON keeps the min-distance chunk per page (tiebroken by chunk_id),
  // and the outer query re-orders the pooled rows by distance. Without this the
  // ANN cut can be filled by several chunks of one page, dropping other pages'
  // best chunks before they rank.
  // With sourceBoost the ranking key flips from raw distance ASC to boosted
  // similarity `(1 - dist) × factor` DESC — same order when every factor is
  // 1.0, curated-tier shaping otherwise. Within one document the factor is
  // constant, so the max-pool inner collapse still keeps the nearest chunk.
  const indexServed = !boostCase && !opts.maxPool;
  const settings = vectorScanSettings({
    kind: engine.kind,
    pgvector: engine.kind === "postgres" && filtered && indexServed ? await pgvectorVersion(engine) : null,
    filtered,
    indexServed,
    limit,
  });
  const relaxed = settings["hnsw.iterative_scan"] === "relaxed_order";
  const sql = opts.maxPool
    ? boostCase
      ? `SELECT bpp.chunk_id FROM (
           SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                  e.chunk_id AS chunk_id,
                  (1 - (e.vector <=> $1::vector)) * ${boostCase} AS sim
             FROM embeddings e
             JOIN chunks c    ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE ${where}
            ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                     sim DESC, e.chunk_id COLLATE "C" ASC
         ) bpp
         ORDER BY bpp.sim DESC, bpp.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
      : `SELECT bpp.chunk_id FROM (
           SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                  e.chunk_id AS chunk_id,
                  (e.vector <=> $1::vector) AS dist
             FROM embeddings e
             JOIN chunks c    ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE ${where}
            ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                     dist ASC, e.chunk_id COLLATE "C" ASC
         ) bpp
         ORDER BY bpp.dist ASC, bpp.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
    : boostCase
      ? `SELECT e.chunk_id FROM embeddings e
         JOIN chunks c     ON c.id = e.chunk_id
         JOIN documents d  ON d.id = c.document_id
         WHERE ${where}
         ORDER BY (1 - (e.vector <=> $1::vector)) * ${boostCase} DESC, e.chunk_id COLLATE "C" ASC
         LIMIT ${limitParam}`
      : relaxed
        ? // A relaxed iterative scan may return rows slightly out of order;
          // the materialized CTE keeps the index scan and re-sorts its output.
          `WITH ann AS MATERIALIZED (
             SELECT e.chunk_id, e.vector <=> $1::vector AS dist
               FROM embeddings e
               JOIN chunks c     ON c.id = e.chunk_id
               JOIN documents d  ON d.id = c.document_id
              WHERE ${where}
              ORDER BY dist
              LIMIT ${limitParam}
           )
           SELECT chunk_id FROM ann ORDER BY dist, chunk_id COLLATE "C"`
        : `SELECT e.chunk_id FROM embeddings e
       JOIN chunks c     ON c.id = e.chunk_id
       JOIN documents d  ON d.id = c.document_id
       WHERE ${where}
       ORDER BY e.vector <=> $1::vector
       LIMIT ${limitParam}`;
  // Settings are applied transaction-locally (set_config is_local=true); see
  // vectorScanSettings for which apply where.
  const names = Object.keys(settings);
  const ids =
    names.length > 0
      ? await engine.transaction(async (tx) => {
          await tx.exec("SET TRANSACTION READ ONLY");
          await tx.query(
            "SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS s(name, value)",
            [names, names.map((n) => settings[n])],
          );
          const r = await tx.query<{ chunk_id: string }>(sql, params);
          return r.rows.map((row) => row.chunk_id);
        })
      : (await engine.query<{ chunk_id: string }>(sql, params)).rows.map((row) => row.chunk_id);
  if (
    opts.onCandidatesIncomplete &&
    engine.kind === "postgres" &&
    filtered &&
    indexServed &&
    ids.length < limit
  ) {
    // Short under a filter: the corpus may simply hold fewer matches, or the
    // index scan ran out of candidates first. A bounded count tells them apart.
    // Postgres only: PGLite runs without the raised ef_search, so a large
    // fanout there always comes back short and would never be cached.
    const probeParams: unknown[] = [];
    const probeWhere = whereFor(probeParams).sql;
    probeParams.push(limit);
    const probe = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM embeddings e
           JOIN chunks c    ON c.id = e.chunk_id
           JOIN documents d ON d.id = c.document_id
          WHERE ${probeWhere}
          LIMIT $${probeParams.length}
       ) matching`,
      probeParams,
    );
    if (Number(probe.rows[0]?.n ?? 0) > ids.length) opts.onCandidatesIncomplete();
  }
  return ids;
}
