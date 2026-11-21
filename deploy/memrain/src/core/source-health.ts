/**
 * source-health.ts — brain-level operational health metrics.
 *
 * memrain is single-holder / effectively single-source, so these are reported at
 * the brain level rather than per-source (a per-source breakdown collapses to
 * one row here). They answer "is the brain ingesting + embedding
 * its data, and is the job queue healthy?":
 *
 *   - embed_coverage_pct : of the chunks that SHOULD carry a vector (markdown /
 *     non-code — code chunks, `kind:'code'`, fill through `memrain embed
 *     --code` and are counted apart — and not
 *     under an `embed_skip` page, which the embed paths never touch), how many
 *     actually have an embeddings row. A low value means the vector arm of
 *     hybrid search can't see those chunks (keyword/FTS still can).
 *   - lag_seconds        : wall-clock staleness = now − newest document update.
 *   - queue_depth        : pending jobs waiting to run.
 *   - failed_jobs_24h    : jobs that FAILED in the last 24h — the one
 *     unambiguous "something broke" signal.
 *
 * Pure read-only aggregation. No Bedrock, no writes. Cheap enough for a doctor
 * probe.
 */
import type { Engine } from "./engine/interface.ts";
import { embeddableChunkFragment } from "./embed-skip.ts";

export interface BrainHealthMetrics {
  /** Chunks expected to carry a vector (non-code, not under an embed-skip page). */
  embeddable_chunks: number;
  /** Of the embeddable chunks, how many have an embeddings row. */
  embedded_chunks: number;
  /** embedded / embeddable, in [0,1]. 1.0 when there is nothing to embed. */
  embed_coverage_pct: number;
  /** Code chunks (`kind:'code'`) — embedded by `memrain embed --code`, excluded from coverage. */
  code_chunks: number;
  /** now − newest document update, in seconds. null when no documents. */
  lag_seconds: number | null;
  /** Pending jobs waiting to run. */
  queue_depth: number;
  /** Jobs that failed in the last 24h. */
  failed_jobs_24h: number;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Soft-deleted and archived documents are on their way out; counting them would
// report stale coverage and lag for content no reader can reach.
const LIVE_DOC = (alias: string): string => `${alias}.deleted_at IS NULL AND NOT ${alias}.archived`;

/**
 * Compute the brain-level health metrics in a handful of cheap aggregate
 * queries. Code chunks (`documents.frontmatter->>'kind' = 'code'`) are excluded
 * from the embedding-coverage denominator because the automatic fills never
 * embed them (the code indexer and `memrain embed --code` do), and chunks under
 * an `embed_skip` page are excluded because the embed paths never touch them —
 * counting either would pin coverage below 100% with no way to converge.
 */
export async function brainHealthMetrics(
  engine: Engine,
): Promise<BrainHealthMetrics> {
  // COUNT(DISTINCT c.id): the LEFT JOIN to embeddings is 1:1 today
  // (embeddings.chunk_id is the PK), but DISTINCT keeps the metric correct even
  // if a future schema lets a chunk carry multiple embedding rows — no risk of
  // coverage exceeding 100%.
  const chunkRow = await engine.query<{
    embeddable: number | string;
    embedded: number | string;
    code: number | string;
  }>(
    `SELECT
       COUNT(DISTINCT c.id) FILTER (
         WHERE ${embeddableChunkFragment("d", "c")}
       )::int AS embeddable,
       COUNT(DISTINCT c.id) FILTER (
         WHERE ${embeddableChunkFragment("d", "c")}
           AND em.chunk_id IS NOT NULL
       )::int AS embedded,
       COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(d.frontmatter->>'kind','') = 'code')::int AS code
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN embeddings em ON em.chunk_id = c.id
     WHERE ${LIVE_DOC("d")}`,
  );
  const embeddable = toInt(chunkRow.rows[0]?.embeddable);
  const embedded = toInt(chunkRow.rows[0]?.embedded);
  const code = toInt(chunkRow.rows[0]?.code);

  const lagRow = await engine.query<{ lag: number | string | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::bigint AS lag FROM documents d WHERE ${LIVE_DOC("d")}`,
  );
  const lag = toNumOrNull(lagRow.rows[0]?.lag);

  const jobRow = await engine.query<{ queue_depth: number | string; failed_24h: number | string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS queue_depth,
       COUNT(*) FILTER (
         WHERE status = 'failed'
           AND (finished_at IS NULL OR finished_at >= NOW() - INTERVAL '24 hours')
       )::int AS failed_24h
     FROM jobs`,
  );
  const queueDepth = toInt(jobRow.rows[0]?.queue_depth);
  const failed24h = toInt(jobRow.rows[0]?.failed_24h);

  return {
    embeddable_chunks: embeddable,
    embedded_chunks: embedded,
    embed_coverage_pct: embeddable > 0 ? embedded / embeddable : 1,
    code_chunks: code,
    lag_seconds: lag,
    queue_depth: queueDepth,
    failed_jobs_24h: failed24h,
  };
}

/**
 * Per-source (per-tenant) health row. The same data/embedding signals the
 * brain-level metric computes, but sliced by `documents.source_id` so a
 * multi-tenant deploy can answer "which source is broken?" instead of hiding
 * one stalled tenant inside the whole-brain average. Queue/failed-jobs are
 * intentionally absent: jobs carry no source_id, so those stay brain-level.
 */
export interface PerSourceHealth {
  /** `documents.source_id`, or `'(unclassified)'` for the NULL-source bucket. */
  source_id: string;
  /** Documents attributed to this source. */
  document_count: number;
  /** Chunks under this source's documents (all kinds). */
  chunk_count: number;
  /** Chunks expected to carry a vector (non-code, not under an embed-skip page). */
  embeddable_chunks: number;
  /** Of the embeddable chunks, how many have an embeddings row. */
  embedded_chunks: number;
  /** embedded / embeddable, in [0,1]. 1.0 when there is nothing to embed. */
  embed_coverage_pct: number;
  /** Code chunks (`kind:'code'`) — embedded by `memrain embed --code`, excluded from coverage. */
  code_chunks: number;
  /** now − newest document update for this source, in seconds. */
  lag_seconds: number | null;
}

export const UNCLASSIFIED_BUCKET = "(unclassified)";

/**
 * Per-source breakdown of the brain-level health signals. Groups by
 * `documents.source_id`, folding NULL into a visible `'(unclassified)'` bucket
 * so unattributed docs are surfaced, not hidden.
 *
 * `sourceIds` scopes the result to a caller's grant: when provided, only rows
 * for those source_ids are returned. A NULL source_id matches no grant, so the
 * `'(unclassified)'` bucket is visible ONLY to an unscoped caller (local CLI /
 * internal token, `sourceIds` undefined) — a scoped tenant never sees it.
 *
 * Additive and read-only: the whole-brain `brainHealthMetrics` is unchanged.
 */
export async function collectPerSourceHealth(
  engine: Engine,
  sourceIds?: string[],
): Promise<PerSourceHealth[]> {
  const scoped = sourceIds !== undefined && sourceIds.length > 0;
  // An empty grant (`[]`) means "no sources visible" → no rows.
  if (sourceIds !== undefined && sourceIds.length === 0) return [];
  const params: unknown[] = scoped ? [sourceIds] : [];
  const docWhere = `WHERE ${LIVE_DOC("documents")}${scoped ? " AND source_id = ANY($1)" : ""}`;
  const chunkWhere = `WHERE ${LIVE_DOC("d")}${scoped ? " AND d.source_id = ANY($1)" : ""}`;

  const docRows = await engine.query<{
    source_id: string;
    document_count: number | string;
    lag: number | string | null;
  }>(
    `SELECT COALESCE(source_id, '${UNCLASSIFIED_BUCKET}') AS source_id,
            COUNT(*)::int AS document_count,
            EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::bigint AS lag
     FROM documents ${docWhere}
     GROUP BY COALESCE(source_id, '${UNCLASSIFIED_BUCKET}')`,
    params,
  );

  const chunkRows = await engine.query<{
    source_id: string;
    chunk_count: number | string;
    embeddable: number | string;
    embedded: number | string;
    code: number | string;
  }>(
    `SELECT COALESCE(d.source_id, '${UNCLASSIFIED_BUCKET}') AS source_id,
            COUNT(DISTINCT c.id)::int AS chunk_count,
            COUNT(DISTINCT c.id) FILTER (
              WHERE ${embeddableChunkFragment("d", "c")}
            )::int AS embeddable,
            COUNT(DISTINCT c.id) FILTER (
              WHERE ${embeddableChunkFragment("d", "c")}
                AND em.chunk_id IS NOT NULL
            )::int AS embedded,
            COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(d.frontmatter->>'kind','') = 'code')::int AS code
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN embeddings em ON em.chunk_id = c.id
     ${chunkWhere}
     GROUP BY COALESCE(d.source_id, '${UNCLASSIFIED_BUCKET}')`,
    params,
  );

  // Merge on source_id. Documents are the spine (a source with docs but no
  // chunks still shows a row); chunk aggregates layer on where present.
  const byId = new Map<string, PerSourceHealth>();
  for (const r of docRows.rows) {
    byId.set(r.source_id, {
      source_id: r.source_id,
      document_count: toInt(r.document_count),
      chunk_count: 0,
      embeddable_chunks: 0,
      embedded_chunks: 0,
      embed_coverage_pct: 1,
      code_chunks: 0,
      lag_seconds: toNumOrNull(r.lag),
    });
  }
  for (const r of chunkRows.rows) {
    const row = byId.get(r.source_id) ?? {
      source_id: r.source_id,
      document_count: 0,
      chunk_count: 0,
      embeddable_chunks: 0,
      embedded_chunks: 0,
      embed_coverage_pct: 1,
      code_chunks: 0,
      lag_seconds: null,
    };
    const embeddable = toInt(r.embeddable);
    const embedded = toInt(r.embedded);
    row.chunk_count = toInt(r.chunk_count);
    row.embeddable_chunks = embeddable;
    row.embedded_chunks = embedded;
    row.code_chunks = toInt(r.code);
    row.embed_coverage_pct = embeddable > 0 ? embedded / embeddable : 1;
    byId.set(r.source_id, row);
  }
  return [...byId.values()].sort((a, b) =>
    a.source_id.localeCompare(b.source_id),
  );
}
