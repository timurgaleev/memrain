import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";
import { RELAXED_STOPWORDS } from "./search/keyword.ts";
import { applySlotEnds } from "./fact-slots.ts";

export interface QueryFact {
  fact_id: number;
  entity_slug: string;
  fact: string;
  valid_from: string | null;
  follow_up: "entity_facts";
  trust?: "external";
}

/** Facts the block shows, and the rows it reads so ended slot values never shorten it. */
const QUERY_FACTS = 3;
const QUERY_FACTS_READ = 12;

const EXTRA_STOPWORDS = new Set(["is", "it", "an", "as", "at", "be", "by", "in", "of", "on", "or", "to", "we",
  "\u0447\u0442\u043E", "\u043A\u0430\u043A", "\u043A\u043E\u0433\u0434\u0430", "\u0433\u0434\u0435", "\u043A\u0442\u043E", "\u044D\u0442\u043E", "\u0434\u043B\u044F", "\u0438\u043B\u0438", "\u0435\u0441\u0442\u044C", "\u043F\u0440\u043E", "\u043F\u0440\u0438", "\u0447\u0435\u043C", "\u0435\u0433\u043E", "\u043E\u043D\u0430", "\u043E\u043D\u0438", "\u043D\u0430\u043C", "\u043D\u0430\u0441", "\u043F\u043E", "\u043D\u0430", "\u0438\u0437", "\u043E\u0442", "\u0434\u043E"]);

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
  const result = await engine.query<QueryFact & { source_id: string; slot_dimension: string | null; valid_until: string | null }>(
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
            'entity_facts'::text AS follow_up, source_id, slot_dimension, valid_until::text AS valid_until
       FROM collapsed ORDER BY matched DESC, written_at DESC, id DESC LIMIT ${QUERY_FACTS_READ}`, params,
  );
  // A slot value a later one ended is no longer current, like a lapsed valid_until.
  const current = await applySlotEnds(engine, {
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(remote ? { visibility: ["world"], excludeDiary: true } : {}),
  }, result.rows.map(r => ({ ...r, id: Number(r.fact_id) })), { activeOnly: true });
  return current.rows.slice(0, QUERY_FACTS).map(({ id, source_id: _s, slot_dimension: _d, valid_until: _v, slot_end: _e, ...r }) => ({ ...r, fact_id: id }));
}
