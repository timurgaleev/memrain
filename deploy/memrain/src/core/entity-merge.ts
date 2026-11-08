/**
 * Entity merge — fold a duplicate/phantom stub page onto an existing canonical
 * page (phantom-redirect, DB-canonical).
 *
 * `renamePage` (pages.ts) carries a page's substrate onto a NEW slug and REFUSES
 * when the target slug is already taken. A merge is exactly that refusal lifted:
 * the target page already EXISTS, and we re-point the duplicate stub's substrate
 * onto it rather than minting a fresh row. Concretely a merge:
 *
 *   1. re-points the stub's `entity_facts` (entity_slug + source_markdown_slug),
 *      `links` (source_slug + target_slug), `timeline_events`, `tags`, and
 *      `page_aliases` onto the canonical slug — dedup-guarded so a row that would
 *      collide with an existing canonical row is dropped, not duplicated;
 *   2. soft-deletes the stub `pages` row (its version history stays attached; the
 *      row is never hard-deleted so the merge is auditable/recoverable);
 *   3. records a durable `stub → canonical` redirect in `slug_aliases`
 *      (migration 067, notes='merge') so a stale `[[stub]]` wikilink and a direct
 *      `page_get stub` still resolve to the canonical page;
 *   4. appends a merge marker to both version chains and bumps the canonical's
 *      generation so the cycle re-derives its salience/search projection.
 *
 * TENANCY: every substrate move is scoped to the STUB's owning `source_id`, so a
 * merge never drags a sibling tenant's rows that happen to share the slug text.
 * A cross-tenant merge (stub and canonical owned by different sources) is refused
 * — as is a scoped caller reaching a page it does not own (reads as "not found").
 *
 * SEARCH MIRROR: the `documents`/`chunks`/`embeddings` projection is NOT moved
 * here (same as `renamePage`) — its ids derive from the mirror `source_path`, so
 * the cycle's `reconcilePageMirrors` backstop re-mirrors the canonical and drops
 * the stub's orphan on its next pass.
 *
 * HOT MEMORY: `hot_memory` is a re-derivable cache with no `source_id` column, so
 * it is intentionally left for the cycle to re-derive against the canonical
 * rather than moved here (moving it unscoped could cross tenants).
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { bumpPageGeneration } from "./generation.ts";
import { setSlugAlias } from "./slug-aliases.ts";
import { lockPageSlugs, validateSlug } from "./pages.ts";
import { carryFactWithdrawals } from "./fact-withdrawals.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { BODY_TIMELINE_KEY_PREFIX } from "./timeline-body.ts";

export interface MergeOptions {
  /** Caller identifier for the audit trail (marker version rows). */
  written_by?: string;
  /**
   * Owning source (tenant). When set, both stub and canonical must resolve
   * within this source — a page owned by another tenant reads as "not found".
   */
  source_id?: string;
}

export interface MergeResult {
  from_slug: string;
  to_slug: string;
  /** True when the stub was folded onto the canonical; false = no-op (see reason). */
  merged: boolean;
  reason?: string;
  /** Per-table rows carried across (observability only). */
  moved?: Record<string, number>;
}

/**
 * Fold `fromSlug` (the duplicate/phantom stub) onto `toSlug` (the canonical
 * page). No-op results (merged:false): from==to, stub missing/deleted, canonical
 * missing/deleted, or a cross-tenant pairing.
 */
export async function mergePage(
  storage: Storage,
  fromSlug: string,
  toSlug: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  validateSlug(fromSlug);
  validateSlug(toSlug);
  if (fromSlug === toSlug) {
    return {
      from_slug: fromSlug,
      to_slug: toSlug,
      merged: false,
      reason: "from and to slugs are identical",
    };
  }
  const scope =
    typeof opts.source_id === "string" && opts.source_id.length > 0
      ? opts.source_id
      : null;
  const writtenBy = opts.written_by ?? null;
  const engine = storage.engine();
  // Deadlock-safe: the fact re-point holds row locks and `carryFactWithdrawals`
  // then takes the withdraw lock, the order a concurrent forget uses too, so
  // Postgres can pick either side as the victim (see retry.ts).
  return deadlockSafeTransaction(engine, async (tx) => {
    await lockPageSlugs(tx, fromSlug, toSlug);
    // Stub must exist, be live, and (when scoped) be owned by the caller.
    const stub = await selectLivePage(tx, fromSlug, scope);
    if (!stub) {
      return {
        from_slug: fromSlug,
        to_slug: toSlug,
        merged: false,
        reason: "source (stub) page not found or deleted",
      };
    }
    // Canonical must ALSO exist + be live — the inverse of rename's guard.
    const canonical = await selectLivePage(tx, toSlug, scope);
    if (!canonical) {
      return {
        from_slug: fromSlug,
        to_slug: toSlug,
        merged: false,
        reason: "target (canonical) page not found or deleted",
      };
    }
    // Refuse a cross-tenant merge. When scoped, both rows already matched the
    // caller's source; when unscoped (local/CLI), the two rows may still belong
    // to different tenants — folding across them would leak substrate.
    const owner = stub.source_id;
    if (owner !== canonical.source_id) {
      return {
        from_slug: fromSlug,
        to_slug: toSlug,
        merged: false,
        reason: "stub and canonical belong to different sources",
      };
    }

    const moved: Record<string, number> = {};
    const move = async (
      label: string,
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      const r = await tx.query<{ one: number }>(sql, params);
      moved[label] = r.rows.length;
    };

    // ── entity_facts ──────────────────────────────────────────────────────
    // Dedup key (mig143): entity, claim hash, chunk and speaker WHERE chunk NOT
    // NULL. Drop stub rows that would collide with an existing canonical fact
    // before re-pointing, so the UPDATE can't trip the unique index.
    await tx.query(
      `DELETE FROM entity_facts s
        WHERE s.entity_slug = $1 AND s.source_id = $3
          AND s.source_chunk_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM entity_facts x
             WHERE x.entity_slug = $2 AND x.source_id = $3
               AND x.fact = s.fact
               AND COALESCE(x.attributed_to, '') = COALESCE(s.attributed_to, '')
               AND x.source_chunk_id = s.source_chunk_id)`,
      [fromSlug, toSlug, owner],
    );
    const fenceCollisions = await tx.query<{ id: number }>(
      `UPDATE entity_facts s
          SET forgotten_at = NOW(), forgotten_cause = 'supersede',
              forgotten_reason = 'merged into ' || $2, superseded_by = x.id
         FROM entity_facts x
        WHERE s.source_markdown_slug = $1 AND s.source_id = $3
          AND s.forgotten_at IS NULL AND s.row_num IS NOT NULL
          AND x.source_markdown_slug = $2 AND x.source_id = s.source_id
          AND x.row_num = s.row_num AND x.forgotten_at IS NULL
        RETURNING s.id`,
      [fromSlug, toSlug, owner],
    );
    const dimensionCollisions = await tx.query<{ id: number }>(
      `UPDATE entity_facts s
          SET forgotten_at = NOW(), forgotten_cause = 'supersede',
              forgotten_reason = 'merged into ' || $2, superseded_by = x.id
         FROM entity_facts x
        WHERE s.entity_slug = $1 AND s.source_id = $3
          AND s.dimension IS NOT NULL AND s.valid_until IS NULL AND s.forgotten_at IS NULL
          AND x.entity_slug = $2 AND x.source_id = s.source_id
          AND x.dimension = s.dimension AND x.value_hash IS NOT DISTINCT FROM s.value_hash
          AND x.source_slug IS NOT DISTINCT FROM s.source_slug
          AND x.valid_until IS NULL AND x.forgotten_at IS NULL
        RETURNING s.id`,
      [fromSlug, toSlug, owner],
    );
    moved.facts_retired = fenceCollisions.rows.length + dimensionCollisions.rows.length;
    await move(
      "entity_facts",
      `UPDATE entity_facts SET entity_slug = $2
        WHERE entity_slug = $1 AND source_id = $3 RETURNING 1 AS one`,
      [fromSlug, toSlug, owner],
    );
    await tx.query(
      `UPDATE entity_facts SET source_markdown_slug = $2
        WHERE source_markdown_slug = $1 AND source_id = $3`,
      [fromSlug, toSlug, owner],
    );
    // Forgotten claims follow the facts to the canonical slug (migration 112).
    const withdrawnFacts = await carryFactWithdrawals(tx, fromSlug, toSlug, owner);
    if (withdrawnFacts > 0) moved.withdrawn_facts = withdrawnFacts;

    // ── links (outbound) ──────────────────────────────────────────────────
    // Unique key (mig059): (source_slug, target_slug, type, source_id). Drop
    // stub-outbound rows colliding with an existing canonical-outbound edge,
    // then re-point source_slug.
    await tx.query(
      `DELETE FROM links l
        WHERE l.source_slug = $1 AND l.source_id = $3
          AND EXISTS (
            SELECT 1 FROM links x
             WHERE x.source_slug = $2 AND x.source_id = $3
               AND x.target_slug = l.target_slug
               AND x.type = l.type)`,
      [fromSlug, toSlug, owner],
    );
    await move(
      "links_out",
      `UPDATE links SET source_slug = $2
        WHERE source_slug = $1 AND source_id = $3 RETURNING 1 AS one`,
      [fromSlug, toSlug, owner],
    );

    // ── links (inbound) ───────────────────────────────────────────────────
    await tx.query(
      `DELETE FROM links l
        WHERE l.target_slug = $1 AND l.source_id = $3
          AND EXISTS (
            SELECT 1 FROM links x
             WHERE x.target_slug = $2 AND x.source_id = $3
               AND x.source_slug = l.source_slug
               AND x.type = l.type)`,
      [fromSlug, toSlug, owner],
    );
    await move(
      "links_in",
      `UPDATE links SET target_slug = $2
        WHERE target_slug = $1 AND source_id = $3 RETURNING 1 AS one`,
      [fromSlug, toSlug, owner],
    );
    // A stub↔canonical edge becomes a canonical→canonical self-loop after the
    // re-point — drop it (a page never legitimately links to itself here).
    await tx.query(
      `DELETE FROM links
        WHERE source_slug = $1 AND target_slug = $1 AND source_id = $2`,
      [toSlug, owner],
    );

    // ── timeline_events ───────────────────────────────────────────────────
    // Dedup keys: (slug, occurred_at, source_chunk_id) WHERE chunk NOT NULL
    // (mig017) and (slug, occurred_at, event, source_label, source_id) WHERE
    // chunk IS NULL (mig079). FK slug→pages; the stub row survives
    // (soft-delete), so the re-point is a plain column move.
    //
    // Body-derived rows are dropped, not moved: they mirror the stub's body,
    // which this merge retires, and their `body-timeline:<stub>:` key would sit
    // outside the canonical page's reconcile prefix, so no later write could
    // ever remove them. The canonical's own body rows are already current.
    await tx.query(
      `DELETE FROM timeline_events
        WHERE slug = $1 AND source_id = $2
          AND starts_with(source_chunk_id, $3)`,
      [fromSlug, owner, BODY_TIMELINE_KEY_PREFIX],
    );
    await tx.query(
      `DELETE FROM timeline_events s
        WHERE s.slug = $1 AND s.source_id = $3
          AND s.source_chunk_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM timeline_events x
             WHERE x.slug = $2 AND x.source_id = $3
               AND x.occurred_at = s.occurred_at
               AND x.source_chunk_id = s.source_chunk_id)`,
      [fromSlug, toSlug, owner],
    );
    // Manual rows (no chunk id): drop a stub row that would collide with an
    // identical canonical manual event under the mig079 key.
    await tx.query(
      `DELETE FROM timeline_events s
        WHERE s.slug = $1 AND s.source_id = $3
          AND s.source_chunk_id IS NULL
          AND EXISTS (
            SELECT 1 FROM timeline_events x
             WHERE x.slug = $2 AND x.source_id = $3
               AND x.source_chunk_id IS NULL
               AND x.occurred_at = s.occurred_at
               AND x.event = s.event
               AND x.source_label = s.source_label)`,
      [fromSlug, toSlug, owner],
    );
    await move(
      "timeline_events",
      `UPDATE timeline_events SET slug = $2
        WHERE slug = $1 AND source_id = $3 RETURNING 1 AS one`,
      [fromSlug, toSlug, owner],
    );

    // ── tags ──────────────────────────────────────────────────────────────
    // Unique key (mig059): (slug, tag, source_id). Drop colliding stub tags.
    await tx.query(
      `DELETE FROM tags s
        WHERE s.slug = $1 AND s.source_id = $3
          AND EXISTS (
            SELECT 1 FROM tags x
             WHERE x.slug = $2 AND x.source_id = $3 AND x.tag = s.tag)`,
      [fromSlug, toSlug, owner],
    );
    await move(
      "tags",
      `UPDATE tags SET slug = $2
        WHERE slug = $1 AND source_id = $3 RETURNING 1 AS one`,
      [fromSlug, toSlug, owner],
    );

    // ── page_aliases (declared free-text names → slug, mig034/073) ────────
    // PK (alias_norm, source_id, slug). The guard matches on (alias_norm,
    // canonical slug) across sources — broader than the key, so a re-point can
    // never collide (an over-delete of a cross-source duplicate name is the
    // safe side; slugs are brain-global today).
    await tx.query(
      `DELETE FROM page_aliases s
        WHERE s.slug = $1
          AND EXISTS (
            SELECT 1 FROM page_aliases x
             WHERE x.slug = $2 AND x.alias_norm = s.alias_norm)`,
      [fromSlug, toSlug],
    );
    await move(
      "page_aliases",
      `UPDATE page_aliases SET slug = $2 WHERE slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );

    // ── Soft-delete the stub + record the redirect ────────────────────────
    await tx.query(
      `UPDATE pages SET deleted_at = NOW(), updated_at = NOW()
        WHERE slug = $1 AND deleted_at IS NULL`,
      [fromSlug],
    );
    // Tombstone on the stub's version chain (history shows where it went).
    await appendMarker(tx, fromSlug, stub.content_hash, writtenBy, owner, {
      merged_into: toSlug,
      merged_at: new Date().toISOString(),
    });
    // Merge marker on the canonical's chain (history shows what it absorbed).
    await appendMarker(tx, toSlug, canonical.content_hash, writtenBy, owner, {
      merged_from: fromSlug,
      merged_at: new Date().toISOString(),
    });

    // Durable stub→canonical redirect (source-scoped, notes='merge' = the audit
    // trail). setSlugAlias also collapses any redirect that pointed AT the stub.
    await setSlugAlias(tx, {
      alias_slug: fromSlug,
      canonical_slug: toSlug,
      source_id: owner,
      notes: "merge",
    });

    await bumpPageGeneration(tx, toSlug);
    await bumpPageGeneration(tx, fromSlug);

    return { from_slug: fromSlug, to_slug: toSlug, merged: true, moved };
  });
}

/** Live `pages` read by slug on a transaction, tenant-scoped when `scope` set. */
async function selectLivePage(
  tx: Engine,
  slug: string,
  scope: string | null,
): Promise<{ source_id: string; content_hash: string } | null> {
  const params: unknown[] = [slug];
  let filter = "";
  if (scope !== null) {
    params.push(scope);
    filter = ` AND source_id = $${params.length}`;
  }
  const r = await tx.query<{ source_id: string; content_hash: string }>(
    `SELECT source_id, content_hash FROM pages
      WHERE slug = $1 AND deleted_at IS NULL${filter}`,
    params,
  );
  return r.rows[0] ?? null;
}

/** Append an event-marker row to a page's version chain (no body change). */
async function appendMarker(
  tx: Engine,
  slug: string,
  contentHash: string,
  writtenBy: string | null,
  sourceId: string,
  marker: Record<string, unknown>,
): Promise<void> {
  const nextN = await tx.query<{ n: number }>(
    `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
       FROM page_versions WHERE slug = $1`,
    [slug],
  );
  await tx.query(
    `INSERT INTO page_versions
       (slug, version_n, hash_prev, hash_new,
        body_snapshot, compiled_truth_snapshot, written_by, written_at, source_id)
     VALUES ($1, $2, $3, $3, '', $4::text::jsonb, $5, NOW(), $6)`,
    [slug, nextN.rows[0]!.n, contentHash, JSON.stringify(marker), writtenBy, sourceId],
  );
}
