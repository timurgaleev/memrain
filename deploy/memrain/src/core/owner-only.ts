/**
 * Owner-only sources. A source marked owner_only (migration 181) is read only
 * by the trusted local operator and by a credential bound to the brain owner,
 * once the brain serves several people (core/caller-access.ts). Every other
 * remote caller gets what a source that does not exist gets: dispatch drops it
 * from the caller's read scope, so every source-scoped read path (pages,
 * documents, chunks, facts and timeline rows stored there, takes and atoms
 * whose origin is there, chronicle events written there) closes at once.
 *
 * What was derived from such a source and stored elsewhere follows its
 * lineage: a fact on a person page in a shared source, an attendee's timeline
 * row, a concept page built from its atoms. Those rows record their origin
 * sources in derived_origins (insert triggers, and `memrain sources provenance`
 * for rows written before 181; until it has been applied, rows derived before
 * then stay open and doctor `owner-only-sources` says so), and the remote read
 * paths test them with ownerOnlyLineageSql. On a one-person brain, or one with no owner-only
 * source, the test is one InitPlan that reads false.
 */
import type { Engine } from "./engine/interface.ts";
import { assertSqlAlias } from "./quarantine.ts";
import { slugifyTitle } from "./synthesis/atoms.ts";
import type { BrainAccess } from "./caller-access.ts";

export type DerivedRowKind = "fact" | "timeline" | "take" | "atom" | "page";

/** Set once `memrain sources provenance --apply` has recorded the origins of rows written before migration 181. */
export const PROVENANCE_BACKFILLED_KEY = "access.provenance_backfilled_at";

export async function provenanceBackfilled(engine: Pick<Engine, "query">): Promise<boolean> {
  const r = await engine.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM config WHERE key = $1) AS ok`, [PROVENANCE_BACKFILLED_KEY]);
  return r.rows[0]?.ok === true;
}

/**
 * ` NOT (owner-only lineage)` for one derived row: true unless the brain
 * serves several people, holds an owner-only source and the row came from it.
 * `idExpr` is an `alias.column` literal from code, never caller input.
 */
export function ownerOnlyLineageSql(kind: DerivedRowKind, idExpr: string): string {
  for (const part of idExpr.split(".")) assertSqlAlias(part);
  return `NOT ((SELECT memrain_owner_only_active()) AND memrain_owner_only_row('${kind}', (${idExpr})::text))`;
}

/** The read scope a non-owner remote caller gets: its grant without the owner-only sources. */
export function narrowOwnerOnlyScope(
  granted: string[] | undefined,
  brain: BrainAccess | null,
  remote: boolean,
): string[] | undefined {
  if (!remote || brain === null || !brain.serves.several || brain.ownerOnlySources.length === 0) return granted;
  const closed = new Set(brain.ownerOnlySources);
  return (granted ?? brain.allSources).filter((id) => !closed.has(id));
}

/**
 * Drops search hits on pages derived from an owner-only source, for a
 * non-owner remote read. A hit names its page by mirror path: `page://<slug>`
 * in the default source, else `page://<source>/<slug>`; both readings are tested.
 */
export async function fenceOwnerOnlyHits<T>(engine: Pick<Engine, "query">, hits: T[], remote: boolean): Promise<T[]> {
  if (!remote || hits.length === 0) return hits;
  const candidates = (hit: T): string[] => {
    const path = (hit as unknown as Record<string, unknown>)["sourcePath"];
    const m = typeof path === "string" ? /^page(?:-truth)?:\/\/(.+)$/.exec(path) : null;
    if (!m) return [];
    const rest = m[1]!;
    const cut = rest.indexOf("/");
    return cut > 0 ? [rest, rest.slice(cut + 1)] : [rest];
  };
  const closed = await ownerOnlyPageSlugs(engine, hits.flatMap(candidates));
  if (closed.size === 0) return hits;
  return hits.filter((h) => !candidates(h).some((slug) => closed.has(slug)));
}

/** Of these page slugs, the ones a non-owner remote caller may not see by lineage. */
export async function ownerOnlyPageSlugs(engine: Pick<Engine, "query">, slugs: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(slugs.filter((s) => typeof s === "string" && s.length > 0))];
  if (unique.length === 0) return new Set();
  const r = await engine.query<{ slug: string }>(
    // scope: operator-only lineage test over slugs the caller's read already returned
    `SELECT s.slug FROM unnest($1::text[]) AS s(slug)
      WHERE (SELECT memrain_owner_only_active()) AND memrain_owner_only_row('page', s.slug)`,
    [unique],
  );
  return new Set(r.rows.map((x) => x.slug));
}

export async function setSourceOwnerOnly(engine: Pick<Engine, "query">, sourceId: string, on: boolean): Promise<{ source_id: string; owner_only: boolean }> {
  const r = await engine.query<{ id: string; owner_only: boolean }>(
    `UPDATE sources SET owner_only = $2 WHERE id = $1 RETURNING id, owner_only`,
    [sourceId, on],
  );
  if (!r.rows[0]) throw new Error(`unknown source "${sourceId}"`);
  return { source_id: r.rows[0].id, owner_only: r.rows[0].owner_only === true };
}

/** Records the origins of a concept page: the sources of the atoms it was built from. */
export async function recordConceptPageOrigins(engine: Pick<Engine, "query">, conceptSlug: string, pageSlug = `concepts/${slugifyTitle(conceptSlug)}`): Promise<number> {
  const r = await engine.query<{ n: number }>(
    // scope: operator-only records lineage metadata for a concept the synthesis cycle wrote
    `WITH ins AS (
       INSERT INTO derived_origins (row_kind, row_id, origin_source_id)
       SELECT DISTINCT 'page', $2, o.src
         FROM synth_concept_atoms ca JOIN synth_atoms a ON a.id = ca.atom_id
         CROSS JOIN LATERAL (SELECT memrain_ref_source(a.source_ref) AS src) o
        WHERE ca.concept_slug = $1 AND o.src IS NOT NULL
          AND o.src IS DISTINCT FROM (SELECT p.source_id FROM pages p WHERE p.slug = $2)
       ON CONFLICT DO NOTHING RETURNING 1)
     SELECT count(*)::int AS n FROM ins`,
    [conceptSlug, pageSlug],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** One kind's backfill numbers. */
export interface ProvenanceKindReport {
  /** Rows with no recorded origin yet whose origin resolves to another source. */
  missing: number;
  /** Of those, rows whose origin is an owner-only source today. */
  owner_only: number;
  /** Origin rows written (0 on a dry run). */
  recorded: number;
}

export interface ProvenanceReport {
  dry_run: boolean;
  kinds: Record<DerivedRowKind, ProvenanceKindReport>;
}

// scope: operator-only the provenance backfill reads every derived row on the brain host
const KIND_SQL: Record<Exclude<DerivedRowKind, "page">, string> = {
  fact: `SELECT 'fact'::text AS kind, t.id::text AS id, t.source_id AS own,
                ARRAY[memrain_ref_source(t.source_slug), memrain_ref_source(t.source_markdown_slug), memrain_chunk_source(t.source_chunk_id)] AS origins
           FROM entity_facts t WHERE NOT EXISTS (SELECT 1 FROM derived_origins d WHERE d.row_kind = 'fact' AND d.row_id = t.id::text)`,
  // scope: operator-only the provenance backfill reads every derived row on the brain host
  timeline: `SELECT 'timeline'::text, t.id::text, t.source_id, ARRAY[memrain_chunk_source(t.source_chunk_id)]
               FROM timeline_events t WHERE NOT EXISTS (SELECT 1 FROM derived_origins d WHERE d.row_kind = 'timeline' AND d.row_id = t.id::text)`,
  take: `SELECT 'take'::text, t.id::text, NULL::text, ARRAY[memrain_ref_source(t.source_ref)]
           FROM synth_takes t WHERE NOT EXISTS (SELECT 1 FROM derived_origins d WHERE d.row_kind = 'take' AND d.row_id = t.id::text)`,
  atom: `SELECT 'atom'::text, t.id::text, NULL::text, ARRAY[memrain_ref_source(t.source_ref)]
           FROM synth_atoms t WHERE NOT EXISTS (SELECT 1 FROM derived_origins d WHERE d.row_kind = 'atom' AND d.row_id = t.id::text)`,
};

/**
 * Records the origins of derived rows written before migration 181. Metadata
 * only: it adds derived_origins rows and changes nothing else. A dry run
 * counts what an apply would record. Safe to repeat: a row already recorded is
 * skipped.
 */
export async function provenanceBackfill(engine: Engine, opts: { apply: boolean }): Promise<ProvenanceReport> {
  const kinds = {} as Record<DerivedRowKind, ProvenanceKindReport>;
  for (const [kind, sql] of Object.entries(KIND_SQL) as Array<[Exclude<DerivedRowKind, "page">, string]>) {
    const pending = `WITH src(kind, id, own, origins) AS (${sql}),
      flat AS (SELECT DISTINCT s.kind, s.id, o FROM src s CROSS JOIN LATERAL unnest(s.origins) AS o
                WHERE o IS NOT NULL AND o IS DISTINCT FROM s.own)`;
    const counted = await engine.query<{ missing: number; owner_only: number }>(
      `${pending}
       SELECT count(DISTINCT id)::int AS missing,
              count(DISTINCT id) FILTER (WHERE EXISTS (SELECT 1 FROM sources so WHERE so.id = flat.o AND so.owner_only))::int AS owner_only
         FROM flat`,
    );
    let recorded = 0;
    if (opts.apply) {
      const ins = await engine.query<{ n: number }>(
        `${pending},
         ins AS (INSERT INTO derived_origins (row_kind, row_id, origin_source_id)
                 SELECT kind, id, o FROM flat ON CONFLICT DO NOTHING RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
      );
      recorded = Number(ins.rows[0]?.n ?? 0);
      if (kind === "fact") {
        // A consolidated take restates its members, so it inherits their origins.
        const takes = await engine.query<{ n: number }>(
          // scope: operator-only the provenance backfill reads every derived row on the brain host
          `WITH ins AS (
             INSERT INTO derived_origins (row_kind, row_id, origin_source_id)
             SELECT DISTINCT 'fact', m.consolidated_into::text, d.origin_source_id
               FROM entity_facts m JOIN derived_origins d ON d.row_kind = 'fact' AND d.row_id = m.id::text
              WHERE m.consolidated_into IS NOT NULL
             ON CONFLICT DO NOTHING RETURNING 1)
           SELECT count(*)::int AS n FROM ins`,
        );
        recorded += Number(takes.rows[0]?.n ?? 0);
      }
    }
    kinds[kind] = { missing: Number(counted.rows[0]?.missing ?? 0), owner_only: Number(counted.rows[0]?.owner_only ?? 0), recorded };
  }
  const concepts = await engine.query<{ concept_slug: string }>(`SELECT concept_slug FROM synth_concepts ORDER BY concept_slug`);
  const page: ProvenanceKindReport = { missing: 0, owner_only: 0, recorded: 0 };
  for (const { concept_slug } of concepts.rows) {
    const pageSlug = `concepts/${slugifyTitle(concept_slug)}`;
    const r = await engine.query<{ missing: number; owner_only: number }>(
      // scope: operator-only the provenance backfill counts concept lineage on the brain host
      `SELECT count(*)::int AS missing, count(*) FILTER (WHERE so.owner_only)::int AS owner_only
         FROM (SELECT DISTINCT memrain_ref_source(a.source_ref) AS src
                 FROM synth_concept_atoms ca JOIN synth_atoms a ON a.id = ca.atom_id WHERE ca.concept_slug = $1) o
         LEFT JOIN sources so ON so.id = o.src
        WHERE o.src IS NOT NULL
          AND o.src IS DISTINCT FROM (SELECT p.source_id FROM pages p WHERE p.slug = $2)
          AND NOT EXISTS (SELECT 1 FROM derived_origins d WHERE d.row_kind = 'page' AND d.row_id = $2 AND d.origin_source_id = o.src)`,
      [concept_slug, pageSlug],
    );
    if (Number(r.rows[0]?.missing ?? 0) > 0) {
      page.missing += 1;
      if (Number(r.rows[0]?.owner_only ?? 0) > 0) page.owner_only += 1;
      if (opts.apply) page.recorded += await recordConceptPageOrigins(engine, concept_slug, pageSlug);
    }
  }
  kinds.page = page;
  if (opts.apply) {
    await engine.query(
      `INSERT INTO config (key, value, updated_at) VALUES ($1, now()::text, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [PROVENANCE_BACKFILLED_KEY],
    );
  }
  return { dry_run: !opts.apply, kinds };
}
