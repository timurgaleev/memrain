import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";
import { RELAXED_STOPWORDS } from "./search/keyword.ts";
import { applySlotEnds } from "./fact-slots.ts";
import { slugCandidatesForPath } from "./search/page-slug.ts";

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

/**
 * Which result pages state a claim a shown fact has replaced: hit index ->
 * the replacing fact's id. A page's claim counts as replaced when a fact
 * taken from that page (its origin page) is, for the same source and entity,
 * either retired with `superseded_by` pointing at a shown fact, or a slot
 * value whose derived end (fact-slots.ts: a later value, stated on the same
 * page or with a change cue, not less trusted) was set by a shown fact.
 *
 * Only what holds today counts: a correcting fact dated in the future, or a
 * slot end that has not arrived yet, marks nothing.
 *
 * Deterministic, no model call. Both the shown facts (already read under the
 * caller's policy) and the older ones are read under the same predicates as
 * matchQueryFacts, so a fact the caller cannot see never marks a page.
 */
export async function supersededClaims(
  engine: Engine,
  hits: ReadonlyArray<{ sourcePath: string; source_id?: string | null }>,
  shownFacts: ReadonlyArray<{ fact_id: number; valid_from: string | null }>,
  sourceIds?: string[],
  remote = false,
  now: Date = new Date(),
): Promise<Map<number, number>> {
  const marks = new Map<number, number>();
  const today = now.toISOString().slice(0, 10);
  const shownFactIds = shownFacts.filter((f) => f.valid_from === null || f.valid_from.slice(0, 10) <= today).map((f) => Number(f.fact_id));
  if (hits.length === 0 || shownFactIds.length === 0 || sourceIds?.length === 0) return marks;
  const pageKeys = hits.map((h) => ({
    source: h.source_id ?? "default",
    slugs: slugCandidatesForPath(h.sourcePath, h.source_id ?? null),
  }));
  const slugs = [...new Set(pageKeys.flatMap((p) => p.slugs))];
  if (slugs.length === 0) return marks;
  const params: unknown[] = [shownFactIds.map(Number), slugs];
  const scope = andSourceScope("o.source_id", sourceIds, params);
  const readable = (alias: string) =>
    `${alias}.dimension IS NULL AND ${factSourceEligibleSql(alias)}` +
    (remote ? ` AND ${alias}.visibility = 'world' AND ${factRemoteEligibleSql(alias)}` : "");
  const rows = (await engine.query<{
    id: number | string; source_id: string; entity_slug: string; page_slug: string;
    superseded_by: number | string | null; slot_dimension: string | null; valid_until: string | null;
  }>(
    `WITH shown AS (
       SELECT n.id, n.source_id, n.entity_slug FROM entity_facts n
        WHERE n.id = ANY($1::bigint[]) AND n.forgotten_at IS NULL AND ${readable("n")}
     )
     SELECT o.id, COALESCE(o.source_id, 'default') AS source_id, o.entity_slug, COALESCE(o.source_markdown_slug, o.source_slug) AS page_slug,
            o.superseded_by, o.slot_dimension, o.valid_until::text AS valid_until
       FROM entity_facts o
       JOIN shown s ON COALESCE(s.source_id, 'default') = COALESCE(o.source_id, 'default') AND s.entity_slug = o.entity_slug
      WHERE COALESCE(o.source_markdown_slug, o.source_slug) = ANY($2::text[])
        AND o.id <> ALL($1::bigint[])
        AND (o.superseded_by = s.id OR (o.forgotten_at IS NULL AND o.slot_dimension IS NOT NULL))
        AND (o.forgotten_at IS NULL OR o.forgotten_cause = 'supersede')
        AND ${readable("o")}${scope}
      ORDER BY o.id`,
    params,
  )).rows.map((r) => ({ ...r, id: Number(r.id), superseded_by: r.superseded_by === null ? null : Number(r.superseded_by) }));
  if (rows.length === 0) return marks;

  const shown = new Set(shownFactIds.map(Number));
  const replacedBy = new Map<number, number>();
  for (const r of rows) if (r.superseded_by !== null && shown.has(r.superseded_by)) replacedBy.set(r.id, r.superseded_by);
  const slotRows = rows.filter((r) => !replacedBy.has(r.id) && r.slot_dimension !== null);
  if (slotRows.length > 0) {
    const ended = await applySlotEnds(engine, {
      ...(sourceIds !== undefined ? { sourceIds } : {}),
      ...(remote ? { visibility: ["world"], excludeDiary: true } : {}),
    }, slotRows, { activeOnly: false });
    for (const r of ended.rows) {
      if (r.slot_end && shown.has(r.slot_end.by) && r.slot_end.at.getTime() <= now.getTime()) replacedBy.set(r.id, r.slot_end.by);
    }
  }

  pageKeys.forEach((page, i) => {
    const old = rows.find((r) => replacedBy.has(r.id) && r.source_id === page.source && page.slugs.includes(r.page_slug));
    if (old) marks.set(i, replacedBy.get(old.id)!);
  });
  return marks;
}
