/**
 * Cosine re-score blend — fold raw query↔chunk semantic similarity back into
 * the fused score BEFORE dedup, so a semantically closer chunk survives the
 * one-chunk-per-doc collapse even when RRF alone ranked it just under a twin.
 *
 * For each candidate we blend:
 *
 *   score = 0.7 * normalizedRRF + 0.3 * cosine
 *
 * where `normalizedRRF` is the hit's fused score divided by the top fused score
 * (0..1), and `cosine` is the pgvector cosine similarity between the query
 * vector and the chunk's stored embedding (`1 - (vector <=> query)`), computed
 * in SQL so no 1024-dim vector is parsed in TS. The blend leaves the score on a
 * comparable 0..1-ish scale that the downstream multiplicative boosts ride.
 *
 * Opt-in (default OFF): it adds one embeddings fetch per query. Runs only when
 * the vector arm produced a query vector — on the keyword-only fallback there is
 * nothing to blend against. Fail-open: any DB error leaves scores untouched.
 */
import type { Engine } from "../engine/interface.ts";
import type { ChunkScore } from "./dedup.ts";
import { andSourceScope } from "../source-scope.ts";
import { embeddingCast } from "../embedding-column.ts";

/** Fraction of the blended score contributed by the normalized RRF score. */
export const RRF_BLEND_WEIGHT = 0.7;
/** Fraction contributed by raw query↔chunk cosine similarity. */
export const COSINE_BLEND_WEIGHT = 0.3;

/**
 * Fetch query↔chunk cosine similarity for a set of chunk ids. Tenant-scoped by
 * `documents.source_id` when `sourceIds` is set (defense-in-depth — the ids
 * already come from a scoped candidate set). Missing embeddings simply don't
 * appear in the map.
 */
export async function fetchCosineSimilarities(
  engine: Engine,
  chunkIds: readonly string[],
  queryVector: number[],
  sourceIds?: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (chunkIds.length === 0) return out;
  const params: unknown[] = [JSON.stringify(queryVector), chunkIds];
  let sourceFilter = "";
  let join = "";
  if (sourceIds !== undefined) {
    join =
      " JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id";
    sourceFilter = andSourceScope("d.source_id", sourceIds, params);
  }
  const vectorCast = await embeddingCast(engine);
  const rows = await engine.query<{ chunk_id: string; cosine: number }>(
    `SELECT e.chunk_id AS chunk_id,
            1 - (e.vector <=> $1${vectorCast}) AS cosine
       FROM embeddings e${join}
      WHERE e.chunk_id = ANY($2::text[])${sourceFilter}`,
    params,
  );
  for (const r of rows.rows) {
    const cos = Number(r.cosine);
    if (Number.isFinite(cos)) out.set(r.chunk_id, cos);
  }
  return out;
}

/**
 * Blend cosine similarity into the fused scores in place. Caller re-sorts.
 * No-op on an empty list. Fail-open on any DB error.
 */
export async function cosineReScore<T>(
  results: ChunkScore<T>[],
  engine: Engine,
  queryVector: number[],
  sourceIds?: readonly string[],
): Promise<void> {
  if (results.length === 0) return;
  let cosines: Map<string, number>;
  try {
    cosines = await fetchCosineSimilarities(
      engine,
      results.map((r) => r.chunkId),
      queryVector,
      sourceIds,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`cosine-rescore: similarity fetch failed (${msg}); search continues`);
    return;
  }
  if (cosines.size === 0) return;

  let maxRrf = Number.NEGATIVE_INFINITY;
  for (const r of results) {
    if (Number.isFinite(r.score) && r.score > maxRrf) maxRrf = r.score;
  }
  const scale = Number.isFinite(maxRrf) && maxRrf > 0 ? maxRrf : 0;

  for (const r of results) {
    const cos = cosines.get(r.chunkId);
    if (cos === undefined) continue;
    const normRrf = scale > 0 ? r.score / scale : 0;
    r.score = RRF_BLEND_WEIGHT * normRrf + COSINE_BLEND_WEIGHT * cos;
  }
}
