import type { Storage } from "../storage.ts";
import { andSourceScope, isNoGrant } from "../source-scope.ts";
import { embeddableChunkFragment } from "../embed-skip.ts";
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";

export function searchDiagnostics(storage: Storage, sourceIds?: readonly string[], filters?: ChunkFilters,
  stages: readonly string[] = ["prepare_cache", "retrieval", "ranking"]) {
  const start = performance.now();
  let prior = start;
  let timings: Record<string, number> = Object.fromEntries(stages.map(stage => [stage, 0]));
  const mark = (stage: string) => {
    const now = performance.now();
    timings = { ...timings, [stage]: (timings[stage] ?? 0) + now - prior };
    prior = now;
  };
  return { mark, finish: async () => {
    mark("finish");
    let pending: number | null = 0;
    if (!isNoGrant(sourceIds)) {
      const params: unknown[] = [];
      const scope = andSourceScope("d.source_id", sourceIds, params);
      const filter = chunkFilterClauses(params, filters);
      try {
        const result = await storage.engine().query<{ n: number | string }>(`SELECT count(*)::int AS n
          FROM chunks c JOIN documents d ON d.id=c.document_id
          WHERE ${embeddableChunkFragment("d", "c")} AND ${visibilityClause("d")}${scope}${filter}
          AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id=c.id)`, params);
        pending = Number(result.rows[0]?.n ?? 0);
      } catch {
        pending = null;
      }
    }
    mark("diagnostics");
    return { timings_ms: { ...timings, total: performance.now() - start }, pending_embeddings: pending };
  } };
}
