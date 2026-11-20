/**
 * pages-purge — the manual escape hatch for hard-deleting soft-deleted pages.
 *
 * memrain soft-deletes pages by flipping `pages.deleted_at` (core/pages.ts
 * deletePage); the row + its append-only `page_versions` chain are kept so a
 * delete is reversible (page_restore). This module is the reaper that finally
 * frees a row once it has aged past `older_than_hours`, cascading to
 * page_versions / page_aliases / links via the FK ON DELETE CASCADE declared in
 * migrations 015 / 016 / 034. `raw_data`, `tags`, `slug_aliases` and `context_volunteer_events` have no
 * foreign key to pages, so their rows are deleted by slug in the same
 * transaction as the page — otherwise a later page on the same slug would
 * inherit them. Only redirects pointing AT a purged page go; a redirect FROM a
 * purged old name to a live page is the rename redirect and stays. Facts
 * written on or about a purged page are retired (cause 'purge') in that
 * transaction too, before the row goes, with a receipt naming the retired ids,
 * and so is what synthesis derived from the page (synthesis/derived-cleanup.ts).
 * An explicit purge of named pages also tombstones their content hashes, so no
 * later write brings the text back.
 *
 * The autopilot `purge` cycle phase (core/cycle/purge.ts) runs the same helper
 * unscoped with the page TTL (PAGE_SOFT_DELETE_TTL_HOURS, 30 days — longer than
 * the 72h document TTL because a page is canonical, not re-ingestable); an operator can also trigger it on demand and see WHICH slugs were
 * reaped. The
 * page search mirror (page://<slug>) was already dropped at soft-delete time, so
 * this only removes the canonical row + its history.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { PAGE_SOFT_DELETE_TTL_HOURS } from "./destructive-guard.ts";
import { OperationError } from "./operation-error.ts";
import { andSourceScope } from "./source-scope.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { hashBody, tombstoneLockKey } from "./pages.ts";
import { applyDerivedCleanup, pageMirrorDocIds, planDerivedCleanup, type DerivedCleanupPlan, type DerivedCleanupResult } from "./synthesis/derived-cleanup.ts";

export interface PurgeDeletedPagesResult {
  /** Number of pages hard-deleted. */
  count: number;
  /** The slugs that were reaped (for the operator's audit). */
  slugs: string[];
  /** Expired pages still referenced by a row that does not cascade; left in place. */
  blocked: Array<{ slug: string; reason: string }>;
  /** The age cutoff in hours this run applied (the default or the caller's). */
  ttl_hours: number;
  /** raw_data / tags / slug_aliases / volunteer-event / hot-memory / synthesis-evidence rows removed with the pages (on a dry run: that would be). */
  raw_data_rows: number;
  tags_rows: number;
  slug_aliases_rows: number;
  volunteer_event_rows: number;
  hot_memory_rows: number;
  synthesis_evidence_rows: number;
  /** Live facts written on or about the purged pages, retired with cause 'purge' (on a dry run: that would be). */
  facts_retired: number;
  /** What synthesis derived from the purged pages, removed with them (on a dry run: that would be). */
  synthesis: DerivedCleanupResult;
  /** Content hashes recorded so the purged text cannot be written back (only with `tombstone`). */
  tombstoned: number;
  /** Set on a dry run: nothing was deleted, `planned` is what a real run would reap now. */
  dry_run?: true;
  planned?: string[];
  /** Hash of the planned slugs; pass it back as `expectedPlanHash` to purge exactly that set. */
  plan_hash?: string;
}

export interface PurgeDeletedPagesOptions {
  /** Only these slugs, and only those soft-deleted past the cutoff. */
  slugs?: string[];
  /** Report what would be reaped and its plan hash; delete nothing. */
  dryRun?: boolean;
  /** Refuse unless the current plan still hashes to this (from an earlier dry run). */
  expectedPlanHash?: string;
  /**
   * Record the content hash of each purged page and of every version it kept,
   * so no write (a connector resync, a re-import, a restored snapshot) brings
   * that text back under any slug of the source. For an explicit purge of
   * named pages; the TTL reaper does not tombstone what it expires.
   */
  tombstone?: boolean;
}

const NO_SYNTHESIS: DerivedCleanupResult = {
  atoms: 0, takes: 0, contradictions: 0, concepts: 0, atom_pages: 0, concepts_regenerated: 0, concept_pages: 0, facts: 0,
};

/** The counts a dry run reports from the cleanup plan. */
function plannedSynthesis(plan: DerivedCleanupPlan): DerivedCleanupResult {
  const pages = plan.concepts.filter((c) => c.page !== null && c.page.action !== "keep").length;
  return {
    atoms: plan.atoms.length, takes: plan.takes.length, contradictions: plan.contradictions.length,
    concepts: plan.concepts.filter((c) => c.action === "retire").length,
    concepts_regenerated: plan.concepts.filter((c) => c.action === "regenerate").length,
    atom_pages: plan.atom_pages.filter((p) => p.action === "retire").length, concept_pages: pages, facts: 0,
  };
}

function synthesisScope(pages: ReadonlyArray<PurgedPage>, factIds: readonly string[]) {
  return {
    docIds: pages.flatMap((p) => pageMirrorDocIds(p.slug, p.source_id)),
    pageSlugs: pages.map((p) => p.slug),
    factIds,
  };
}

/**
 * Record the hashes of what the pages held, now and in every kept version,
 * skipping the empty body every soft-delete marker carries.
 */
async function tombstonePages(tx: Engine, pages: ReadonlyArray<PurgedPage>, purgeId: string): Promise<number> {
  if (pages.length === 0) return 0;
  const hashes = (await tx.query<{ source_id: string; h: string; slug: string }>(
    // scope: upstream the pages this purge locked, each with its own source
    `WITH gone AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS g(slug, source_id)
     )
     SELECT g.source_id, p.content_hash AS h, g.slug FROM gone g JOIN pages p ON p.slug = g.slug
     UNION
     SELECT g.source_id, v.hash_new, g.slug FROM gone g JOIN page_versions v ON v.slug = g.slug WHERE v.body_snapshot <> ''
     ORDER BY 1, 2, 3`,
    [pages.map((p) => p.slug), pages.map((p) => p.source_id)],
  )).rows.filter((row) => row.h !== null && row.h !== hashBody(""));
  // The same lock a write takes before it checks for a tombstone, so no write
  // of this content commits between the check and this insert.
  for (const key of [...new Set(hashes.map((row) => tombstoneLockKey(row.source_id, row.h)))].sort()) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
  }
  if (hashes.length === 0) return 0;
  const r = await tx.query<{ n: number }>(
    `WITH recorded AS (
       INSERT INTO page_purges (source_id, content_hash, slug, purge_id)
       SELECT source_id, h, slug, $4::uuid FROM unnest($1::text[], $2::text[], $3::text[]) AS t(source_id, h, slug)
       ON CONFLICT (source_id, content_hash, slug) DO UPDATE SET purge_id = EXCLUDED.purge_id, purged_at = NOW()
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM recorded`,
    [hashes.map((row) => row.source_id), hashes.map((row) => row.h), hashes.map((row) => row.slug), purgeId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * First 16 hex of the SHA-256 of the planned pages, one `slug<TAB>deleted_at`
 * line each, sorted. The deletion time is in it so a page restored, edited
 * and deleted again after the dry run is not purged under the old review.
 */
export function purgePlanHash(entries: ReadonlyArray<{ slug: string; deleted_at: string }>): string {
  const lines = entries.map((e) => `${e.slug}\t${e.deleted_at}`).sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 16);
}

const FOREIGN_KEY_VIOLATION = "23503";

type Leftovers = Pick<PurgeDeletedPagesResult,
  "raw_data_rows" | "tags_rows" | "slug_aliases_rows" | "volunteer_event_rows" | "hot_memory_rows" | "synthesis_evidence_rows">;

/** Tables that name a page by slug with no foreign key to pages: [result key, table, slug column]. */
export const LEFTOVER_TABLES: ReadonlyArray<[keyof Leftovers, string, string]> = [
  ["raw_data_rows", "raw_data", "slug"],
  ["tags_rows", "tags", "slug"],
  ["slug_aliases_rows", "slug_aliases", "canonical_slug"],
  ["volunteer_event_rows", "context_volunteer_events", "slug"],
  // An observation seen on the page, and the citations of a synthesis page.
  ["hot_memory_rows", "hot_memory", "source_slug"],
  ["synthesis_evidence_rows", "synthesis_evidence", "synthesis_slug"],
];

const NO_LEFTOVERS: Leftovers = {
  raw_data_rows: 0, tags_rows: 0, slug_aliases_rows: 0, volunteer_event_rows: 0, hot_memory_rows: 0, synthesis_evidence_rows: 0,
};

/**
 * An observation that a purged one replaced would read as current once the
 * foreign key nulls its `superseded_by`. Point it at the first surviving
 * observation further along the chain instead, the one that replaced the
 * purged one. A chain that ends inside the purged pages has no such row: the
 * replaced observation is then the newest one a page still backs, as if the
 * purged page had never been written, and it reads as current again.
 */
async function repointReplacedObservations(engine: Engine, slugs: string[]): Promise<void> {
  await engine.query(
    `WITH RECURSIVE gone AS (
       SELECT id FROM hot_memory WHERE source_slug = ANY($1::text[])
     ), chain AS (
       SELECT g.id AS start, h.superseded_by AS next, 0 AS depth
         FROM gone g JOIN hot_memory h ON h.id = g.id
       UNION ALL
       SELECT c.start, h.superseded_by, c.depth + 1
         FROM chain c JOIN gone g ON g.id = c.next JOIN hot_memory h ON h.id = c.next
        WHERE c.depth < 1000
     ), heir AS (
       SELECT start, next FROM chain WHERE next IS NOT NULL AND next NOT IN (SELECT id FROM gone)
     )
     UPDATE hot_memory h SET superseded_by = heir.next
       FROM heir
      WHERE h.superseded_by = heir.start AND h.id NOT IN (SELECT id FROM gone)`,
    [slugs],
  );
}

/**
 * Count (or, with `remove`, delete) the rows that would outlive the given
 * pages. `pages.slug` is the primary key, so a purged slug has no owner left
 * and every row on it goes, whatever its source_id.
 */
export async function leftovers(engine: Engine, slugs: string[], remove: boolean): Promise<Leftovers> {
  const out: Leftovers = { ...NO_LEFTOVERS };
  if (slugs.length === 0) return out;
  if (remove) await repointReplacedObservations(engine, slugs);
  for (const [key, table, column] of LEFTOVER_TABLES) {
    const r = await engine.query<{ n: number }>(
      remove
        ? `WITH d AS (DELETE FROM ${table} WHERE ${column} = ANY($1::text[]) RETURNING 1) SELECT count(*)::int AS n FROM d`
        : `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::text[])`,
      [slugs],
    );
    out[key] = r.rows[0]?.n ?? 0;
  }
  return out;
}

type PurgedPage = { slug: string; source_id: string };

/**
 * Retire the live facts written on or about the given pages, or with no
 * `purgeId` only count them. A fact is written on a page when its fence row
 * came from it, or, with no fence origin, when it names the page as its
 * source, in the page's own source. A fact about a page (the page is its
 * entity) goes too when the page it names as its source does not survive the
 * purge either; one that names no source page was stated directly and stays,
 * and so does an ontology observation (`dimension` set). While the page was soft-deleted those facts were
 * hidden by `factSourceEligibleSql`; once its row is gone nothing hides them,
 * and a later page on the slug would inherit them. Another page stating the
 * same claim holds its own fact row, so nothing it supports is lost. Each
 * page's retired ids go into one receipt row, so the retirement can be undone
 * by id.
 */
async function retireFacts(engine: Engine, pages: ReadonlyArray<PurgedPage>, purgeId: string | null): Promise<string[] | number> {
  if (pages.length === 0) return purgeId === null ? 0 : [];
  const doomed = `WITH gone AS (
      SELECT * FROM unnest($1::text[], $2::text[]) AS g(slug, source_id)
    ), matched AS (
      SELECT f.id, g.slug, g.source_id
        FROM entity_facts f
        JOIN gone g
          ON (f.source_markdown_slug = g.slug OR (f.source_markdown_slug IS NULL AND f.source_slug = g.slug))
         AND COALESCE(f.source_id, 'default') = g.source_id
       WHERE f.forgotten_at IS NULL
      UNION ALL
      SELECT f.id, g.slug, g.source_id
        FROM entity_facts f
        JOIN gone g ON f.entity_slug = g.slug AND COALESCE(f.source_id, 'default') = g.source_id
       WHERE f.forgotten_at IS NULL AND f.dimension IS NULL AND COALESCE(f.source_markdown_slug, f.source_slug) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.slug = COALESCE(f.source_markdown_slug, f.source_slug)
                                                AND hp.slug <> ALL($1::text[]))
    ), doomed AS (
      SELECT DISTINCT ON (id) id, slug, source_id FROM matched ORDER BY id, slug)`;
  const params: unknown[] = [pages.map((p) => p.slug), pages.map((p) => p.source_id)];
  if (purgeId === null) {
    const r = await engine.query<{ n: number }>(`${doomed} SELECT count(*)::int AS n FROM doomed`, params);
    return r.rows[0]?.n ?? 0;
  }
  params.push(purgeId);
  const r = await engine.query<{ id: string }>(
    `${doomed}, retired AS (
       UPDATE entity_facts f
          SET forgotten_at = NOW(), forgotten_cause = 'purge', forgotten_reason = 'page purged: ' || d.slug
         FROM doomed d
        WHERE f.id = d.id AND f.forgotten_at IS NULL
       RETURNING f.id, d.slug, d.source_id
     ), receipts AS (
       INSERT INTO fact_purge_receipts (purge_id, page_slug, source_id, fact_ids)
       SELECT $3::uuid, slug, source_id, array_agg(id ORDER BY id) FROM retired GROUP BY slug, source_id
       RETURNING 1
     )
     SELECT id::text AS id FROM retired`,
    params,
  );
  return r.rows.map((row) => row.id);
}

/**
 * Inside the purge transaction, before the page rows go: retire the facts,
 * remove what synthesis derived from the pages, and tombstone their content
 * when asked.
 */
async function retireDerived(tx: Engine, pages: ReadonlyArray<PurgedPage>, purgeId: string, tombstone: boolean) {
  const factIds = await retireFacts(tx, pages, purgeId) as string[];
  const synthesis = pages.length === 0 ? { ...NO_SYNTHESIS }
    : await applyDerivedCleanup(tx, await planDerivedCleanup(tx, synthesisScope(pages, factIds)), purgeId);
  const tombstoned = tombstone ? await tombstonePages(tx, pages, purgeId) : 0;
  return { facts_retired: factIds.length, synthesis, tombstoned };
}

/**
 * Hard-delete pages whose `deleted_at` is older than `olderThanHours`.
 * Idempotent: a run with nothing expired returns count 0. Defaults to the
 * page soft-delete TTL (720h) when no cutoff is given.
 *
 * A set-based DELETE aborts the whole sweep when any one page is still
 * referenced, so on a foreign-key violation it falls back to one DELETE per page:
 * a blocked page is reported and the other expired pages still go.
 */
export async function purgeDeletedPages(
  engine: Engine,
  olderThanHours: number = PAGE_SOFT_DELETE_TTL_HOURS,
  sourceIds?: string[],
  opts: PurgeDeletedPagesOptions = {},
): Promise<PurgeDeletedPagesResult> {
  // Tenant write scope (mig047): when a scope is given, the reaper only frees
  // rows owned by it — a scoped caller can never purge another tenant's
  // soft-deleted pages, and an empty grant purges nothing. Unset → whole-brain.
  const params: unknown[] = [String(olderThanHours)];
  const sourceFilter = andSourceScope("source_id", sourceIds, params);
  let slugFilter = "";
  if (opts.slugs !== undefined) {
    params.push([...new Set(opts.slugs)]);
    slugFilter = ` AND slug = ANY($${params.length}::text[])`;
  }
  let expiredWhere = `deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' hours')::interval${sourceFilter}${slugFilter}`;
  if (opts.dryRun || opts.expectedPlanHash !== undefined) {
    const plan = await engine.query<{ slug: string; deleted_at: string; source_id: string }>(
      `SELECT slug, deleted_at::text AS deleted_at, source_id FROM pages WHERE ${expiredWhere} ORDER BY slug`,
      params,
    );
    const planned = plan.rows.map((r) => r.slug);
    const planHash = purgePlanHash(plan.rows);
    if (opts.dryRun) {
      return {
        count: 0, slugs: [], blocked: [], ttl_hours: olderThanHours,
        ...(await leftovers(engine, planned, false)),
        facts_retired: await retireFacts(engine, plan.rows, null) as number,
        synthesis: plan.rows.length === 0 ? { ...NO_SYNTHESIS }
          : plannedSynthesis(await planDerivedCleanup(engine, synthesisScope(plan.rows, []))),
        tombstoned: 0,
        dry_run: true, planned, plan_hash: planHash,
      };
    }
    if (planHash !== opts.expectedPlanHash) {
      throw new OperationError(
        "conflict",
        `the purge plan changed since the dry run (now ${planned.length} page(s), plan_hash ${planHash})`,
        "Run the dry run again, review the planned slugs, and pass the new plan_hash.",
      );
    }
    // Exactly the reviewed pages: one that expires, or is restored and deleted
    // again, between the check and the DELETE waits for the next run.
    params.push(planned, plan.rows.map((r) => r.deleted_at));
    expiredWhere += ` AND (slug, deleted_at::text) IN (SELECT * FROM unnest($${params.length - 1}::text[], $${params.length}::text[]))`;
  }
  const purgeId = randomUUID();
  // Fast path: one set-based DELETE plus the leftovers, in one transaction.
  // Every table referencing pages cascades today, so this almost always
  // succeeds; a violation rolls the whole transaction back, fact retirement
  // included. The pages are locked first so their facts are retired before
  // the rows go, and the DELETE takes exactly the locked set.
  try {
    return await deadlockSafeTransaction(engine, async (tx) => {
      const locked = await tx.query<PurgedPage>(
        `SELECT slug, source_id FROM pages WHERE ${expiredWhere} ORDER BY slug FOR UPDATE`,
        params,
      );
      const derived = await retireDerived(tx, locked.rows, purgeId, opts.tombstone === true);
      const r = await tx.query<{ slug: string }>(
        `DELETE FROM pages WHERE slug = ANY($1::text[]) RETURNING slug`,
        [locked.rows.map((row) => row.slug)],
      );
      const slugs = r.rows.map((row) => row.slug).sort();
      return {
        count: slugs.length, slugs, blocked: [], ttl_hours: olderThanHours,
        ...(await leftovers(tx, slugs, true)), ...derived,
      };
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== FOREIGN_KEY_VIOLATION) throw err;
  }
  // Slow path, reached only when some expired page is still referenced by a
  // row that does not cascade: one transaction per page so the stuck ones are
  // reported and the rest still go. Never one transaction around the loop,
  // where the first violation aborts it.
  const expired = await engine.query<{ slug: string; deleted_at: string }>(
    `SELECT slug, deleted_at::text AS deleted_at FROM pages WHERE ${expiredWhere} ORDER BY slug`,
    params,
  );
  const slugs: string[] = [];
  const blocked: Array<{ slug: string; reason: string }> = [];
  const removed: Leftovers = { ...NO_LEFTOVERS };
  let factsRetired = 0;
  let tombstoned = 0;
  const synthesis: DerivedCleanupResult = { ...NO_SYNTHESIS };
  for (const { slug, deleted_at: deletedAt } of expired.rows) {
    try {
      // Same predicate again, pinned to the deletion the scan saw (and so to
      // the reviewed plan): a restore, a move, or a restore and a new delete
      // between the scan and this row keeps the page.
      const rowParams: unknown[] = [String(olderThanHours), slug, deletedAt];
      const rowFilter = andSourceScope("source_id", sourceIds, rowParams);
      const gone = await deadlockSafeTransaction(engine, async (tx) => {
        const locked = await tx.query<PurgedPage>(
          `SELECT slug, source_id FROM pages
            WHERE slug = $2 AND deleted_at IS NOT NULL
              AND deleted_at::text = $3
              AND deleted_at < NOW() - ($1 || ' hours')::interval${rowFilter}
            FOR UPDATE`,
          rowParams,
        );
        if (locked.rows.length === 0) return null;
        const derived = await retireDerived(tx, locked.rows, purgeId, opts.tombstone === true);
        await tx.query(`DELETE FROM pages WHERE slug = $1`, [slug]);
        return { ...(await leftovers(tx, [slug], true)), ...derived };
      });
      if (gone) {
        slugs.push(slug);
        for (const [key] of LEFTOVER_TABLES) removed[key] += gone[key];
        factsRetired += gone.facts_retired;
        tombstoned += gone.tombstoned;
        for (const key of Object.keys(synthesis) as Array<keyof DerivedCleanupResult>) synthesis[key] += gone.synthesis[key];
      }
    } catch (err) {
      if ((err as { code?: string })?.code !== FOREIGN_KEY_VIOLATION) throw err;
      blocked.push({ slug, reason: "still referenced by a row that does not cascade" });
    }
  }
  return { count: slugs.length, slugs, blocked, ttl_hours: olderThanHours, ...removed, facts_retired: factsRetired, synthesis, tombstoned };
}

/** Clear the purge tombstones of `slug` in `sourceId`, so its old text can be written again. Returns how many went. */
export async function clearPageTombstones(engine: Engine, slug: string, sourceId: string): Promise<number> {
  const r = await engine.query(`DELETE FROM page_purges WHERE source_id = $1 AND slug = $2 RETURNING 1`, [sourceId, slug]);
  return r.rows.length;
}
