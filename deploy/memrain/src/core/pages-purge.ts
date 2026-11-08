/**
 * pages-purge — the manual escape hatch for hard-deleting soft-deleted pages.
 *
 * memrain soft-deletes pages by flipping `pages.deleted_at` (core/pages.ts
 * deletePage); the row + its append-only `page_versions` chain are kept so a
 * delete is reversible (page_restore). This module is the reaper that finally
 * frees a row once it has aged past `older_than_hours`, cascading to
 * page_versions / page_aliases / links via the FK ON DELETE CASCADE declared in
 * migrations 015 / 016 / 034. `raw_data`, `tags` and `slug_aliases` have no
 * foreign key to pages, so their rows are deleted by slug in the same
 * transaction as the page — otherwise a later page on the same slug would
 * inherit them. Only redirects pointing AT a purged page go; a redirect FROM a
 * purged old name to a live page is the rename redirect and stays.
 *
 * The autopilot `purge` cycle phase (core/cycle/purge.ts) runs the same helper
 * unscoped with the page TTL (PAGE_SOFT_DELETE_TTL_HOURS, 30 days — longer than
 * the 72h document TTL because a page is canonical, not re-ingestable); an operator can also trigger it on demand and see WHICH slugs were
 * reaped. The
 * page search mirror (page://<slug>) was already dropped at soft-delete time, so
 * this only removes the canonical row + its history.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { PAGE_SOFT_DELETE_TTL_HOURS } from "./destructive-guard.ts";
import { OperationError } from "./operation-error.ts";
import { andSourceScope } from "./source-scope.ts";
import { deadlockSafeTransaction } from "./retry.ts";

export interface PurgeDeletedPagesResult {
  /** Number of pages hard-deleted. */
  count: number;
  /** The slugs that were reaped (for the operator's audit). */
  slugs: string[];
  /** Expired pages still referenced by a row that does not cascade; left in place. */
  blocked: Array<{ slug: string; reason: string }>;
  /** The age cutoff in hours this run applied (the default or the caller's). */
  ttl_hours: number;
  /** raw_data / tags / slug_aliases rows removed with the pages (on a dry run: that would be). */
  raw_data_rows: number;
  tags_rows: number;
  slug_aliases_rows: number;
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

type Leftovers = Pick<PurgeDeletedPagesResult, "raw_data_rows" | "tags_rows" | "slug_aliases_rows">;

/** Tables that name a page by slug with no foreign key to pages: [result key, table, slug column]. */
const LEFTOVER_TABLES: ReadonlyArray<[keyof Leftovers, string, string]> = [
  ["raw_data_rows", "raw_data", "slug"],
  ["tags_rows", "tags", "slug"],
  ["slug_aliases_rows", "slug_aliases", "canonical_slug"],
];

const NO_LEFTOVERS: Leftovers = { raw_data_rows: 0, tags_rows: 0, slug_aliases_rows: 0 };

/**
 * Count (or, with `remove`, delete) the rows that would outlive the given
 * pages. `pages.slug` is the primary key, so a purged slug has no owner left
 * and every row on it goes, whatever its source_id.
 */
async function leftovers(engine: Engine, slugs: string[], remove: boolean): Promise<Leftovers> {
  const out: Leftovers = { ...NO_LEFTOVERS };
  if (slugs.length === 0) return out;
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
    const plan = await engine.query<{ slug: string; deleted_at: string }>(
      `SELECT slug, deleted_at::text AS deleted_at FROM pages WHERE ${expiredWhere} ORDER BY slug`,
      params,
    );
    const planned = plan.rows.map((r) => r.slug);
    const planHash = purgePlanHash(plan.rows);
    if (opts.dryRun) {
      return {
        count: 0, slugs: [], blocked: [], ttl_hours: olderThanHours,
        ...(await leftovers(engine, planned, false)),
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
  // Fast path: one set-based DELETE plus the leftovers, in one transaction.
  // Every table referencing pages cascades today, so this almost always
  // succeeds; a violation rolls the whole transaction back.
  try {
    return await deadlockSafeTransaction(engine, async (tx) => {
      const r = await tx.query<{ slug: string }>(
        `DELETE FROM pages WHERE ${expiredWhere} RETURNING slug`,
        params,
      );
      const slugs = r.rows.map((row) => row.slug).sort();
      return { count: slugs.length, slugs, blocked: [], ttl_hours: olderThanHours, ...(await leftovers(tx, slugs, true)) };
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
  for (const { slug, deleted_at: deletedAt } of expired.rows) {
    try {
      // Same predicate again, pinned to the deletion the scan saw (and so to
      // the reviewed plan): a restore, a move, or a restore and a new delete
      // between the scan and this row keeps the page.
      const rowParams: unknown[] = [String(olderThanHours), slug, deletedAt];
      const rowFilter = andSourceScope("source_id", sourceIds, rowParams);
      const gone = await deadlockSafeTransaction(engine, async (tx) => {
        const r = await tx.query<{ slug: string }>(
          `DELETE FROM pages
            WHERE slug = $2 AND deleted_at IS NOT NULL
              AND deleted_at::text = $3
              AND deleted_at < NOW() - ($1 || ' hours')::interval${rowFilter}
            RETURNING slug`,
          rowParams,
        );
        return r.rows.length > 0 ? leftovers(tx, [slug], true) : null;
      });
      if (gone) {
        slugs.push(slug);
        for (const [key] of LEFTOVER_TABLES) removed[key] += gone[key];
      }
    } catch (err) {
      if ((err as { code?: string })?.code !== FOREIGN_KEY_VIOLATION) throw err;
      blocked.push({ slug, reason: "still referenced by a row that does not cascade" });
    }
  }
  return { count: slugs.length, slugs, blocked, ttl_hours: olderThanHours, ...removed };
}
