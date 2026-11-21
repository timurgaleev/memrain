/**
 * Per-entity dimensional ontology, riding the `entity_facts` table (migration
 * 097 adds dimension/value/value_hash/dim_status). A dimensional claim is just
 * a fact with an ontology tag, so the existing bi-temporal (valid_from/
 * valid_until) and lifecycle (forgotten_at, superseded_by, consolidated_into,
 * visibility) columns apply unchanged.
 *
 * Merge semantics (all under an advisory lock so concurrent writers on the same
 * axis serialize):
 *   (a) identical value on the current axis, same source     → idempotent noop
 *   (b) identical value from a DIFFERENT source              → corroboration
 *   (c) different value, dated at/after the current          → forward supersede
 *   (d) different value, backdated before the current        → closed history
 *   (e) novel dimension (not a seed/alias)                   → quarantined
 */
import { ownerOnlyLineageSql } from "./owner-only.ts";
import { supersededValidUntilSql } from "./fact-validity.ts";
import type { Storage } from "./storage.ts";
import { guardFields } from "./secret-scan.ts";
import {
  valueHash,
  normalizeDimension,
  isNovelDimension,
} from "./chronicle/ontology.ts";
import type {
  OntologyObservationInput,
  OntologyMergeResult,
  OntologyValue,
  OntologyDimensionStat,
  OntologyConflict,
  OntologyReadOpts,
} from "./chronicle/types.ts";

/** A distinct-source corroboration nudges the current row's confidence up. */
const CORROBORATION_BUMP = 0.05;

/** Remote read fence: only world-visible, non-diary-sourced rows reach an
 *  untrusted caller. Static SQL (no bound param), appended when worldOnly. */
const WORLD_FENCE =
  "AND visibility = 'world' AND (source_slug IS NULL OR source_slug NOT LIKE 'life/diary/%') AND " +
  ownerOnlyLineageSql("fact", "entity_facts.id");

/** entity_facts.confidence is CHECK 0..1; default 0.7 when unset. */
function clampConfidence(c: number | undefined): number {
  if (typeof c !== "number" || !Number.isFinite(c)) return 0.7;
  return Math.min(1, Math.max(0, c));
}

function requireScope(sourceIds: readonly string[] | undefined): string[] {
  if (!sourceIds || sourceIds.length === 0) {
    throw new Error("ontology read requires an explicit sourceIds scope");
  }
  return [...sourceIds];
}

export async function mergeOntologyFact(
  storage: Storage,
  input: OntologyObservationInput & { sourceId: string },
): Promise<OntologyMergeResult> {
  // Guarded before the hash: a redacted value must dedup against itself, not
  // against the raw credential.
  const guarded = await guardFields(
    storage.engine(),
    `ontology:${input.entitySlug}`,
    input.sourceId,
    `ontology fact on '${input.entitySlug}'`,
    { value: input.value, dimension: input.dimension },
  );
  const obs = { ...input, ...guarded };
  const dimension = normalizeDimension(obs.dimension);
  const vh = valueHash(obs.value);
  const conf = clampConfidence(obs.confidence);
  const status = obs.status ?? (isNovelDimension(dimension) ? "quarantined" : "active");
  const visibility = obs.visibility ?? "private";
  const validFrom = obs.validFrom ?? null;
  const validTo = obs.validTo ?? null;
  const sourceSlug = obs.source_slug ?? null;
  const factText = `${dimension}: ${obs.value}`;
  const lockKey = `${obs.sourceId}:${obs.entitySlug}:${dimension}`;

  return storage.engine().transaction(async (tx) => {
    // Serialize concurrent writers on this (tenant, entity, dimension) axis so a
    // read-modify-write supersession can't interleave into a double-current.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

    // The current OPEN, non-forgotten, active row on this axis. mig097's dedup
    // index is narrowed to exactly these rows, so a value that once CLOSED can
    // legitimately reopen (A→B→A) without colliding with its historical row.
    const cur = await tx.query<{
      id: number; value_hash: string; valid_from: string | null; source_slug: string | null;
    }>(
      `SELECT id, value_hash, valid_from::text AS valid_from, source_slug FROM entity_facts
        WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3
          AND forgotten_at IS NULL AND valid_until IS NULL
          AND (dim_status IS NULL OR dim_status = 'active')
        ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC
        LIMIT 1`,
      [obs.sourceId, obs.entitySlug, dimension],
    );
    const current = cur.rows[0];

    // (a)/(b) — proposed value equals the CURRENT OPEN value. Same source →
    // idempotent noop; a DIFFERENT source → corroboration (a forgotten row +
    // a confidence bump). The narrowed unique index no longer covers forgotten
    // rows, so corroboration dedup is an explicit check, not ON CONFLICT.
    if (current && current.value_hash === vh) {
      if ((current.source_slug ?? null) === sourceSlug) {
        return { action: "noop", factId: Number(current.id), supersededId: null };
      }
      const dup = await tx.query<{ id: number }>(
        `SELECT id FROM entity_facts
          WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND value_hash = $4
            AND forgotten_cause = 'consolidate'
            AND ((source_slug IS NULL AND $5::text IS NULL) OR source_slug = $5)
          LIMIT 1`,
        [obs.sourceId, obs.entitySlug, dimension, vh, sourceSlug],
      );
      if (dup.rows.length) {
        return { action: "noop", factId: Number(dup.rows[0]!.id), supersededId: null };
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
            confidence, source_slug, valid_from, valid_until, forgotten_at, forgotten_cause,
            consolidated_into, source_id)
         VALUES ($1, $2, 'fact', $3, $4, $5, $6, $7, $8, $9,
                 COALESCE($10::date, CURRENT_DATE), NULL, NOW(), 'consolidate', $11, $12)
         RETURNING id`,
        [obs.entitySlug, factText, visibility, dimension, obs.value, vh, status, conf,
          sourceSlug, validFrom, current.id, obs.sourceId],
      );
      await tx.query(
        `UPDATE entity_facts SET confidence = LEAST(1.0, confidence + $2) WHERE id = $1`,
        [current.id, CORROBORATION_BUMP],
      );
      return { action: "corroborated", factId: Number(ins.rows[0]!.id), supersededId: null };
    }

    // Different value. A backdated observation (older than the current row) is
    // recorded as a CLOSED historical interval and never rewrites the current.
    // A closed insert is outside the narrowed index, so it takes no ON CONFLICT.
    const backdated =
      current != null && status === "active" && validFrom != null && current.valid_from != null &&
      new Date(validFrom).getTime() < new Date(current.valid_from).getTime();

    if (backdated) {
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
            confidence, source_slug, valid_from, valid_until, source_id)
         VALUES ($1, $2, 'fact', $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12)
         RETURNING id`,
        [obs.entitySlug, factText, visibility, dimension, obs.value, vh, status, conf,
          sourceSlug, validFrom, current!.valid_from, obs.sourceId],
      );
      return { action: "inserted", factId: Number(ins.rows[0]!.id), supersededId: null, conflict: true };
    }

    // New OPEN row (forward supersession or a first observation). The ON CONFLICT
    // arbiter is mig097's narrowed index — predicate must match it EXACTLY.
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO entity_facts
         (entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
          confidence, source_slug, valid_from, valid_until, source_id)
       VALUES ($1, $2, 'fact', $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::date, CURRENT_DATE), $11::date, $12)
       ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_slug)
         WHERE dimension IS NOT NULL AND valid_until IS NULL AND forgotten_at IS NULL
       DO NOTHING
       RETURNING id`,
      [obs.entitySlug, factText, visibility, dimension, obs.value, vh, status, conf,
        sourceSlug, validFrom, validTo, obs.sourceId],
    );
    if (ins.rows.length === 0) return { action: "noop", factId: null, supersededId: null };
    const newId = Number(ins.rows[0]!.id);

    let supersededId: number | null = null;
    // Only an ACTIVE observation supersedes; a quarantined novel value must not
    // silently close a confirmed current value.
    if (current && status === "active") {
      await tx.query(
        `UPDATE entity_facts
            SET valid_until = ${supersededValidUntilSql(2)}, superseded_by = $3
          WHERE id = $1 AND valid_until IS NULL`,
        [current.id, validFrom, newId],
      );
      supersededId = current.id;
    }
    return {
      action: supersededId ? "superseded_prior" : "inserted",
      factId: newId,
      supersededId,
    };
  });
}

/**
 * The live value per dimension for an entity, with `--asof` valid-time travel.
 * DISTINCT ON (dimension) picks the newest-valid, highest-confidence row.
 * Quarantined dimensions are excluded unless `includeQuarantined`.
 */
export async function getOntology(
  storage: Storage,
  entity: string,
  opts: OntologyReadOpts,
): Promise<OntologyValue[]> {
  const scope = requireScope(opts.sourceIds);
  const asof = opts.asof ?? null;
  const minConf = opts.minConfidence ?? 0;
  const includeQ = opts.includeQuarantined ?? false;
  const worldOnly = opts.worldOnly ?? false;
  const r = await storage.engine().query<OntologyValue>(
    `SELECT DISTINCT ON (dimension)
        dimension, value, confidence, source_slug,
        valid_from::text AS valid_from, valid_until::text AS valid_to,
        COALESCE(dim_status, 'active') AS status, id AS fact_id
     FROM entity_facts
     WHERE entity_slug = $1 AND dimension IS NOT NULL AND forgotten_at IS NULL
       AND source_id = ANY($2::text[])
       AND COALESCE(valid_from, '-infinity'::date) <= COALESCE($3::date, CURRENT_DATE)
       AND COALESCE(valid_until, 'infinity'::date) > COALESCE($3::date, CURRENT_DATE)
       AND confidence >= $4
       AND ($5::boolean OR dim_status IS NULL OR dim_status = 'active')
       AND ($6::boolean = false OR (visibility = 'world' AND ${ownerOnlyLineageSql("fact", "entity_facts.id")}))
     ORDER BY dimension, valid_from DESC NULLS LAST, confidence DESC, id DESC`,
    [entity, scope, asof, minConf, includeQ, worldOnly],
  );
  return r.rows.map((row) => ({
    ...row,
    confidence: Number(row.confidence),
    fact_id: Number(row.fact_id),
  }));
}

/** Which dimensions exist across the (scoped) corpus, and how heavily used.
 *  `worldOnly` restricts the count to world-visible, non-diary rows so a
 *  private-only or diary-only axis name never surfaces to a remote caller. */
export async function discoverOntologyDimensions(
  storage: Storage,
  opts: { sourceIds: readonly string[]; worldOnly?: boolean },
): Promise<OntologyDimensionStat[]> {
  const scope = requireScope(opts.sourceIds);
  const fence = opts.worldOnly ? WORLD_FENCE : "";
  const r = await storage.engine().query<{
    dimension: string;
    entities: number;
    observations: number;
  }>(
    `SELECT dimension, count(DISTINCT entity_slug)::int AS entities, count(*)::int AS observations
     FROM entity_facts
     WHERE dimension IS NOT NULL AND forgotten_at IS NULL AND source_id = ANY($1::text[]) ${fence}
     GROUP BY dimension
     ORDER BY entities DESC, dimension`,
    [scope],
  );
  return r.rows.map((row) => ({
    dimension: row.dimension,
    entities: Number(row.entities),
    observations: Number(row.observations),
  }));
}

/**
 * Entities whose CURRENTLY-OPEN observations on one dimension disagree — at
 * least two distinct values from at least two distinct named sources. Only open
 * rows are considered, so a forward supersession (which closes the prior) does
 * NOT read as a conflict.
 */
export async function findOntologyConflicts(
  storage: Storage,
  opts: { sourceIds: readonly string[]; minConfidence?: number; worldOnly?: boolean },
): Promise<OntologyConflict[]> {
  const scope = requireScope(opts.sourceIds);
  const minConf = opts.minConfidence ?? 0;
  // Remote fence: only world-visible, non-diary values enter the conflict set,
  // so a private value never reaches a tenant via a disagreement surface.
  const fence = opts.worldOnly ? WORLD_FENCE : "";
  const r = await storage.engine().query<{
    entity_slug: string;
    dimension: string;
    values: OntologyConflict["values"];
  }>(
    `WITH cur AS (
        SELECT entity_slug, dimension, value, source_slug, confidence, id AS fact_id
        FROM entity_facts
        WHERE dimension IS NOT NULL AND forgotten_at IS NULL AND valid_until IS NULL
          AND (dim_status IS NULL OR dim_status = 'active')
          AND confidence >= $2 AND source_id = ANY($1::text[]) ${fence}
      )
      SELECT entity_slug, dimension,
             json_agg(json_build_object(
               'value', value, 'source_slug', source_slug,
               'confidence', confidence, 'fact_id', fact_id)) AS values
      FROM cur
      GROUP BY entity_slug, dimension
      HAVING count(DISTINCT value) >= 2 AND count(DISTINCT source_slug) >= 2
      ORDER BY entity_slug, dimension`,
    [scope, minConf],
  );
  return r.rows.map((row) => ({
    entity_slug: row.entity_slug,
    dimension: row.dimension,
    values: row.values,
  }));
}
