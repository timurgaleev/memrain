/**
 * After a forget: other live facts about the same entity that read close to the
 * claim just withdrawn. A forget retires exact restatements of the claim; a
 * reworded copy survives it, and an agent that is told about the near misses
 * can ask the user whether they mean the same thing.
 *
 * No model call. The withdrawn fact's stored embedding is compared in SQL when
 * it has one (cosine), otherwise its text is compared by pg_trgm similarity.
 * Candidates share the withdrawn fact's source, visibility and entity, so the
 * check can never reach past the scope the forget itself was allowed. The
 * result carries fact ids and scores only, never fact text.
 */
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";

export const SIMILAR_ACTIVE_LIMIT = 5;
export const SIMILAR_ACTIVE_MIN_COSINE = 0.8;
export const SIMILAR_ACTIVE_MIN_TRIGRAM = 0.45;

export interface SimilarActive {
  state: "checked" | "not_checked";
  /** How candidates were scored; null when nothing was checked. */
  method: "embedding" | "trigram" | null;
  candidates: Array<{ fact_id: number; similarity: number }>;
  next: string;
}

export interface SimilarActiveOptions {
  /** The caller's write scope; undefined is the unscoped operator. */
  sourceIds?: string[];
  /** A remote caller is told only about `world` facts. */
  remote?: boolean;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export async function similarActiveAfterForget(
  engine: Engine,
  factId: number,
  opts: SimilarActiveOptions = {},
): Promise<SimilarActive> {
  const anchorParams: unknown[] = [factId];
  const anchorScope = andSourceScope("source_id", opts.sourceIds, anchorParams);
  const anchor = await engine.query<{ has_embedding: boolean; entity_slug: string }>(
    `SELECT embedding IS NOT NULL AS has_embedding, entity_slug
       FROM entity_facts WHERE id = $1${anchorScope}`,
    anchorParams,
  );
  const row = anchor.rows[0];
  if (!row) {
    return {
      state: "not_checked",
      method: null,
      candidates: [],
      next: "The forgotten fact is not visible to this caller, so similar facts were not checked.",
    };
  }
  const method = row.has_embedding ? "embedding" : "trigram";
  const score = method === "embedding"
    ? "(1 - (c.embedding <=> n.embedding))"
    : "similarity(lower(c.fact), lower(n.fact))";
  const extra = method === "embedding" ? "AND c.embedding IS NOT NULL" : "";
  const params: unknown[] = [
    factId,
    opts.remote === true,
    method === "embedding" ? SIMILAR_ACTIVE_MIN_COSINE : SIMILAR_ACTIVE_MIN_TRIGRAM,
    SIMILAR_ACTIVE_LIMIT,
  ];
  const scope = andSourceScope("n.source_id", opts.sourceIds, params);
  const r = await engine.query<{ id: number | string; similarity: number | string }>(
    `SELECT c.id, (${score})::float8 AS similarity
       FROM entity_facts n
       JOIN entity_facts c
         ON c.source_id = n.source_id
        AND c.visibility = n.visibility
        AND c.entity_slug = n.entity_slug
        AND c.id <> n.id
      WHERE n.id = $1${scope}
        AND c.forgotten_at IS NULL
        AND c.dimension IS NULL
        AND ($2::boolean = false OR c.visibility = 'world')
        ${extra}
        AND ${score} >= $3
      ORDER BY similarity DESC, c.id
      LIMIT $4`,
    params,
  );
  const candidates = r.rows.map((c) => ({ fact_id: Number(c.id), similarity: round3(Number(c.similarity)) }));
  if (candidates.length === 0) {
    return {
      state: "checked",
      method,
      candidates,
      next: "No close matches among the remaining live facts about this entity (this does not prove every rewording is gone).",
    };
  }
  return {
    state: "checked",
    method,
    candidates,
    next: `Close matches are not necessarily the same claim. Show these facts to the user (entity_facts on ${row.entity_slug}) and forget one only if the user confirms it restates what was withdrawn.`,
  };
}
