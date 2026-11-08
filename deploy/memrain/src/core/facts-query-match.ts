import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";
import { RELAXED_STOPWORDS } from "./search/keyword.ts";

export interface QueryFact {
  fact_id: number;
  entity_slug: string;
  fact: string;
  valid_from: string | null;
  follow_up: "entity_facts";
  trust?: "external";
}

const EXTRA_STOPWORDS = new Set(["is", "it", "an", "as", "at", "be", "by", "in", "of", "on", "or", "to", "we",
  "что", "как", "когда", "где", "кто", "это", "для", "или", "есть", "про", "при", "чем", "его", "она", "они", "нам", "нас", "по", "на", "из", "от", "до"]);

/** A small lexical ledger supplement, independent of chunk ranking and embeddings. */
export async function matchQueryFacts(
  engine: Engine, query: string, sourceIds?: string[], remote = false,
): Promise<QueryFact[]> {
  if (sourceIds?.length === 0) return [];
  const parsed = await engine.query<{ lexeme: string }>(
    "SELECT lexeme FROM unnest(to_tsvector('simple', $1)) ORDER BY positions[1], lexeme", [query.slice(0, 4096)],
  );
  const words = parsed.rows.map(r => r.lexeme)
    .filter(w => w.length >= 2 && !RELAXED_STOPWORDS.has(w) && !EXTRA_STOPWORDS.has(w)).slice(0, 32);
  if (words.length === 0) return [];
  const minimum = Math.min(4, Math.ceil(words.length * 0.75));
  const params: unknown[] = [words, minimum];
  const scope = andSourceScope("f.source_id", sourceIds, params);
  const orQuery = words.map((_, i) => `plainto_tsquery('simple', ($1::text[])[${i + 1}])`).join(" || ");
  const key = "entity_slug, COALESCE(attributed_to, ''), memrain_fact_claim_key(fact)";
  const result = await engine.query<QueryFact>(
    `WITH eligible AS (
       SELECT f.*, to_tsvector('simple', f.fact) AS terms FROM entity_facts f
        WHERE f.forgotten_at IS NULL AND f.dimension IS NULL
          AND ${factSourceEligibleSql("f")}${scope}
          ${remote ? `AND f.visibility = 'world' AND ${factRemoteEligibleSql("f")}` : ""}
     ), matching AS (
       SELECT *, (SELECT count(*)::int FROM unnest($1::text[]) word
                   WHERE terms @@ plainto_tsquery('simple', word)) AS matched
         FROM eligible WHERE terms @@ (${orQuery})
     ), collapsed AS (
       SELECT DISTINCT ON (${key}) * FROM matching WHERE matched >= $2
        ORDER BY ${key}, written_at DESC, id DESC
     )
     SELECT id AS fact_id, entity_slug, fact, valid_from::text AS valid_from,
            'entity_facts'::text AS follow_up
       FROM collapsed ORDER BY matched DESC, written_at DESC, id DESC LIMIT 3`, params,
  );
  return result.rows.map(r => ({ ...r, fact_id: Number(r.fact_id) }));
}
