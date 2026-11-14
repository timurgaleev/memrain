/**
 * Storage for the connector sync engine (migration 153): per-stream cursors,
 * the provider item → page map with failure counts and holds, and the notices
 * an owner sees.
 *
 * Every timestamp is passed in by the caller, so a run's notion of "now" is
 * one clock, and tests can drive it.
 *
 * `held_reason` carries three kinds of hold:
 *   - an item hold: an error code; the item failed `ITEM_HOLD_AFTER` runs in a
 *     row on the same version and waits out a back-off instead of blocking its
 *     stream's cursor;
 *   - a deletion state: `delete_pending` (seen deleted upstream, not applied
 *     yet), `mass_delete` (over the threshold, waiting for the owner) and
 *     `delete_confirmed` (the owner said yes; the next run applies it);
 *   - a retention state, for a live item whose page aged out of its window in
 *     a sweep past the mass-delete guard: `retention_held` (waiting for the
 *     owner), `retention_confirmed` (the owner said yes; the next sweep
 *     deletes it) and `retention_kept` (the owner said no; sweeps leave it
 *     until the item changes upstream, which clears every hold).
 */
import type { Engine } from "../engine/interface.ts";

export const DELETE_PENDING = "delete_pending";
export const MASS_DELETE = "mass_delete";
export const DELETE_CONFIRMED = "delete_confirmed";
export const RETENTION_HELD = "retention_held";
export const RETENTION_CONFIRMED = "retention_confirmed";
export const RETENTION_KEPT = "retention_kept";
export const RETENTION_STATES: readonly string[] = [RETENTION_HELD, RETENTION_CONFIRMED, RETENTION_KEPT];
/** Every hold that is not an item failing: none of these is retried, counted as held, or a hold code. */
export const DELETION_STATES: readonly string[] = [DELETE_PENDING, MASS_DELETE, DELETE_CONFIRMED, ...RETENTION_STATES];

/** Consecutive failed runs on one version before an item is held. */
export const ITEM_HOLD_AFTER = 3;
const HOUR_MS = 3_600_000;
/** Back-off of a held item by how many times it has failed: 1 h, 6 h, then a day. */
export function holdBackoffMs(failCount: number): number {
  if (failCount <= ITEM_HOLD_AFTER) return HOUR_MS;
  if (failCount === ITEM_HOLD_AFTER + 1) return 6 * HOUR_MS;
  return 24 * HOUR_MS;
}

const CODE_RE = /^[a-z0-9_]{1,40}$/;
/** An error code fit to store as a hold reason; never one of the deletion states. */
export function holdCode(code: string): string {
  return CODE_RE.test(code) && !DELETION_STATES.includes(code) ? code : "item_error";
}

export type NoticeKind = "needs_reconnect" | "mass_delete_held" | "items_held";

export interface ItemRow {
  external_id: string;
  external_version: string | null;
  page_slug: string | null;
  dedupe_key: string | null;
  content_hash: string | null;
  deleted_upstream_at: Date | null;
  fail_count: number;
  held_reason: string | null;
  held_until: Date | null;
}

interface RawItemRow {
  external_id: string;
  external_version: string | null;
  page_slug: string | null;
  dedupe_key: string | null;
  content_hash: string | null;
  deleted_upstream_at: string | Date | null;
  fail_count: number | string;
  held_reason: string | null;
  held_until: string | Date | null;
}

const toDate = (v: string | Date | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

function toItem(r: RawItemRow): ItemRow {
  return {
    external_id: r.external_id,
    external_version: r.external_version,
    page_slug: r.page_slug,
    dedupe_key: r.dedupe_key,
    content_hash: r.content_hash,
    deleted_upstream_at: toDate(r.deleted_upstream_at),
    fail_count: Number(r.fail_count),
    held_reason: r.held_reason,
    held_until: toDate(r.held_until),
  };
}

const ITEM_COLS = `external_id, external_version, page_slug, dedupe_key, content_hash, deleted_upstream_at,
                   fail_count, held_reason, held_until`;

export async function readCursor(engine: Engine, accountId: string, stream: string): Promise<string | null> {
  const r = await engine.query<{ cursor: string }>(
    `SELECT cursor FROM connector_cursors WHERE account_id = $1 AND stream = $2`,
    [accountId, stream],
  );
  return r.rows[0]?.cursor ?? null;
}

export async function writeCursor(engine: Engine, accountId: string, stream: string, cursor: string, now: Date = new Date()): Promise<void> {
  await engine.query(
    `INSERT INTO connector_cursors (account_id, stream, cursor, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
    [accountId, stream, cursor, now.toISOString()],
  );
}

export async function getItem(engine: Engine, accountId: string, externalId: string): Promise<ItemRow | null> {
  const r = await engine.query<RawItemRow>(
    `SELECT ${ITEM_COLS} FROM connector_items WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId],
  );
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

/**
 * The version each of `externalIds` is settled at: stored as a page, not
 * failing, not held (a retention hold rides on a settled item), not deleted
 * upstream. An adapter whose provider has no cheap change feed skips fetching
 * an item whose listed version matches.
 */
export async function settledItemVersions(engine: Engine, accountId: string, externalIds: readonly string[]): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();
  const r = await engine.query<{ external_id: string; external_version: string }>(
    `SELECT external_id, external_version FROM connector_items
      WHERE account_id = $1 AND external_id = ANY($2::text[]) AND external_version IS NOT NULL
        AND page_slug IS NOT NULL AND fail_count = 0 AND deleted_upstream_at IS NULL
        AND (held_reason IS NULL OR held_reason = ANY($3::text[]))`,
    [accountId, [...externalIds], [...RETENTION_STATES]],
  );
  return new Map(r.rows.map(row => [row.external_id, row.external_version]));
}

/** Ids of the account's items stored as pages and not deleted upstream: what a deletion reconcile checks. */
export async function liveItemIds(engine: Engine, accountId: string): Promise<string[]> {
  const r = await engine.query<{ external_id: string }>(
    `SELECT external_id FROM connector_items
      WHERE account_id = $1 AND page_slug IS NOT NULL AND deleted_upstream_at IS NULL
      ORDER BY external_id`,
    [accountId],
  );
  return r.rows.map(row => row.external_id);
}

/** The page another item of this account already became under `dedupeKey`, if any. */
export async function pageForDedupeKey(engine: Engine, accountId: string, dedupeKey: string, externalId: string): Promise<string | null> {
  const r = await engine.query<{ page_slug: string }>(
    `SELECT page_slug FROM connector_items
      WHERE account_id = $1 AND dedupe_key = $2 AND external_id <> $3
        AND page_slug IS NOT NULL AND deleted_upstream_at IS NULL
      ORDER BY first_seen_at LIMIT 1`,
    [accountId, dedupeKey, externalId],
  );
  return r.rows[0]?.page_slug ?? null;
}

/** True when another item of the account, not deleted upstream, is stored as `pageSlug`. */
export async function pageSharedByLiveItem(engine: Engine, accountId: string, pageSlug: string, externalId: string): Promise<boolean> {
  const r = await engine.query(
    `SELECT 1 FROM connector_items
      WHERE account_id = $1 AND page_slug = $2 AND external_id <> $3 AND deleted_upstream_at IS NULL
      LIMIT 1`,
    [accountId, pageSlug, externalId],
  );
  return r.rows.length > 0;
}

export interface SettledItem {
  accountId: string;
  externalId: string;
  version: string | null;
  pageSlug: string;
  contentHash: string | null;
  dedupeKey: string | null;
  now: Date;
}

/** The item is in the brain as `pageSlug`: clear its failures, hold and any deletion. */
export async function recordItemSettled(engine: Engine, s: SettledItem): Promise<void> {
  await engine.query(
    `INSERT INTO connector_items (account_id, external_id, external_version, page_slug, dedupe_key, content_hash,
                                  first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (account_id, external_id) DO UPDATE SET
       external_version = EXCLUDED.external_version, page_slug = EXCLUDED.page_slug,
       dedupe_key = EXCLUDED.dedupe_key, content_hash = EXCLUDED.content_hash,
       last_seen_at = EXCLUDED.last_seen_at, deleted_upstream_at = NULL,
       fail_count = 0, last_error = NULL, held_reason = NULL, held_until = NULL`,
    [s.accountId, s.externalId, s.version, s.pageSlug, s.dedupeKey, s.contentHash, s.now.toISOString()],
  );
}

/** Seen again unchanged. */
export async function touchItem(engine: Engine, accountId: string, externalId: string, now: Date): Promise<void> {
  await engine.query(
    `UPDATE connector_items SET last_seen_at = $3 WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId, now.toISOString()],
  );
}

export interface FailureOutcome {
  failCount: number;
  held: boolean;
}

/**
 * Count one failed run for the item. A new version starts the count over and
 * drops an old hold. At `ITEM_HOLD_AFTER` the item is held with a back-off;
 * `holdNow` holds at once (a refusal no retry can change).
 */
export async function recordItemFailure(
  engine: Engine,
  f: { accountId: string; externalId: string; version: string | null; code: string; message: string; now: Date; holdNow?: boolean },
): Promise<FailureOutcome> {
  const r = await engine.query<{ fail_count: number | string }>(
    `INSERT INTO connector_items (account_id, external_id, external_version, fail_count, last_error, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 1, $4, $5, $5)
     ON CONFLICT (account_id, external_id) DO UPDATE SET
       fail_count = CASE WHEN connector_items.external_version IS NOT DISTINCT FROM EXCLUDED.external_version
                         THEN connector_items.fail_count + 1 ELSE 1 END,
       held_reason = CASE WHEN connector_items.external_version IS NOT DISTINCT FROM EXCLUDED.external_version
                          THEN connector_items.held_reason ELSE NULL END,
       held_until = CASE WHEN connector_items.external_version IS NOT DISTINCT FROM EXCLUDED.external_version
                         THEN connector_items.held_until ELSE NULL END,
       external_version = EXCLUDED.external_version,
       last_error = EXCLUDED.last_error, last_seen_at = EXCLUDED.last_seen_at
     RETURNING fail_count`,
    [f.accountId, f.externalId, f.version, f.message.slice(0, 500), f.now.toISOString()],
  );
  const failCount = Number(r.rows[0]!.fail_count);
  if (f.holdNow !== true && failCount < ITEM_HOLD_AFTER) return { failCount, held: false };
  await engine.query(
    `UPDATE connector_items SET held_reason = $3, held_until = $4 WHERE account_id = $1 AND external_id = $2`,
    [f.accountId, f.externalId, holdCode(f.code), new Date(f.now.getTime() + holdBackoffMs(failCount)).toISOString()],
  );
  return { failCount, held: true };
}

/** Items of the account processed since `since` (one row per item). */
export async function itemsSeenSince(engine: Engine, accountId: string, since: Date): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM connector_items WHERE account_id = $1 AND last_seen_at >= $2`,
    [accountId, since.toISOString()],
  );
  return Number(r.rows[0]!.n);
}

/** Record upstream deletions as pending. Unknown ids and rows already deleted are ignored. */
export async function markDeletesPending(engine: Engine, accountId: string, externalIds: readonly string[], now: Date): Promise<number> {
  if (externalIds.length === 0) return 0;
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items SET deleted_upstream_at = $3, held_reason = '${DELETE_PENDING}', held_until = NULL
      WHERE account_id = $1 AND external_id = ANY($2::text[]) AND deleted_upstream_at IS NULL
      RETURNING external_id`,
    [accountId, [...externalIds], now.toISOString()],
  );
  return r.rows.length;
}

/**
 * After a full relisting of one stream: record as pending deletions the
 * stored items under `prefix` that the listing did not touch since `since`.
 * A held or failing item may simply not have been processed, so it is never
 * taken for gone; neither is an item that never made a page.
 */
export async function markUnseenDeletesPending(engine: Engine, accountId: string, prefix: string, since: Date, now: Date): Promise<number> {
  if (prefix === "" || Number.isNaN(since.getTime())) throw new Error("reconcile needs a prefix and a valid start time");
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items SET deleted_upstream_at = $4, held_reason = '${DELETE_PENDING}', held_until = NULL
      WHERE account_id = $1 AND left(external_id, length($2::text)) = $2::text AND last_seen_at < $3
        AND deleted_upstream_at IS NULL AND page_slug IS NOT NULL AND fail_count = 0
        AND (held_reason IS NULL OR held_reason = ANY($5::text[]))
      RETURNING external_id`,
    [accountId, prefix, since.toISOString(), now.toISOString(), [...RETENTION_STATES]],
  );
  return r.rows.length;
}

/** Items still in the brain: not deleted upstream, or deleted but not applied yet. */
export async function itemsPresent(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM connector_items
      WHERE account_id = $1 AND page_slug IS NOT NULL
        AND (deleted_upstream_at IS NULL OR held_reason = ANY($2::text[]))`,
    [accountId, [...DELETION_STATES]],
  );
  return Number(r.rows[0]!.n);
}

export async function itemsInDeletionState(engine: Engine, accountId: string, state: string): Promise<ItemRow[]> {
  const r = await engine.query<RawItemRow>(
    `SELECT ${ITEM_COLS} FROM connector_items WHERE account_id = $1 AND held_reason = $2 ORDER BY external_id`,
    [accountId, state],
  );
  return r.rows.map(toItem);
}

/** Move every pending deletion of the account to `mass_delete`, waiting for the owner. */
export async function holdPendingDeletes(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items SET held_reason = '${MASS_DELETE}'
      WHERE account_id = $1 AND held_reason = '${DELETE_PENDING}' RETURNING external_id`,
    [accountId],
  );
  return r.rows.length;
}

/** The deletion ran: the row stays as the record that the item is gone upstream. */
export async function recordDeleteApplied(engine: Engine, accountId: string, externalId: string): Promise<void> {
  await engine.query(
    `UPDATE connector_items SET held_reason = NULL, held_until = NULL WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId],
  );
}

/**
 * Mark the live items behind `pageSlugs` as held by a retention sweep past the
 * guard. An item already in a deletion or retention state keeps it; an item
 * failure hold gives way, as the page it would retry is the aged one.
 */
export async function holdRetentionDeletes(engine: Engine, accountId: string, pageSlugs: readonly string[]): Promise<number> {
  if (pageSlugs.length === 0) return 0;
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items SET held_reason = '${RETENTION_HELD}', held_until = NULL
      WHERE account_id = $1 AND page_slug = ANY($2::text[]) AND deleted_upstream_at IS NULL
        AND (held_reason IS NULL OR NOT (held_reason = ANY($3::text[])))
      RETURNING external_id`,
    [accountId, [...pageSlugs], [...DELETION_STATES]],
  );
  return r.rows.length;
}

/** Items whose deletion waits for the owner: held upstream deletions and held retention deletions. */
export async function heldDeleteCount(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM connector_items WHERE account_id = $1 AND held_reason IN ('${MASS_DELETE}', '${RETENTION_HELD}')`,
    [accountId],
  );
  return Number(r.rows[0]!.n);
}

/** The owner confirmed the held deletions: the next run applies them whatever their number. */
export async function confirmHeldDeletes(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items
        SET held_reason = CASE held_reason WHEN '${MASS_DELETE}' THEN '${DELETE_CONFIRMED}' ELSE '${RETENTION_CONFIRMED}' END
      WHERE account_id = $1 AND held_reason IN ('${MASS_DELETE}', '${RETENTION_HELD}') RETURNING external_id`,
    [accountId],
  );
  await resolveNotice(engine, accountId, "mass_delete_held");
  return r.rows.length;
}

/**
 * The owner refused the held deletions: the pages stay. A held upstream
 * deletion reads as live again; a held retention deletion is kept, so the
 * next sweep does not ask again.
 */
export async function rejectHeldDeletes(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items
        SET held_reason = CASE held_reason WHEN '${MASS_DELETE}' THEN NULL ELSE '${RETENTION_KEPT}' END,
            deleted_upstream_at = CASE held_reason WHEN '${MASS_DELETE}' THEN NULL ELSE deleted_upstream_at END
      WHERE account_id = $1 AND held_reason IN ('${MASS_DELETE}', '${RETENTION_HELD}') RETURNING external_id`,
    [accountId],
  );
  await resolveNotice(engine, accountId, "mass_delete_held");
  return r.rows.length;
}

/** Items held for failing (deletion states excluded). */
export async function heldItemCount(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM connector_items
      WHERE account_id = $1 AND held_reason IS NOT NULL AND NOT (held_reason = ANY($2::text[]))`,
    [accountId, [...DELETION_STATES]],
  );
  return Number(r.rows[0]!.n);
}

/** Let every held item of the account be tried again on the next run. */
export async function retryHeldItems(engine: Engine, accountId: string): Promise<number> {
  const r = await engine.query<{ external_id: string }>(
    `UPDATE connector_items SET held_reason = NULL, held_until = NULL, fail_count = 0
      WHERE account_id = $1 AND held_reason IS NOT NULL AND NOT (held_reason = ANY($2::text[]))
      RETURNING external_id`,
    [accountId, [...DELETION_STATES]],
  );
  await resolveNotice(engine, accountId, "items_held");
  return r.rows.length;
}

/** Open the account's notice of `kind`, or refresh the detail of the open one. */
export async function openNotice(engine: Engine, accountId: string, kind: NoticeKind, detail: string, now: Date = new Date()): Promise<void> {
  await engine.query(
    `INSERT INTO connector_notices (account_id, kind, detail, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, kind) WHERE resolved_at IS NULL DO UPDATE SET detail = EXCLUDED.detail`,
    [accountId, kind, detail.slice(0, 1000), now.toISOString()],
  );
}

export async function resolveNotice(engine: Engine, accountId: string, kind: NoticeKind, now: Date = new Date()): Promise<void> {
  await engine.query(
    `UPDATE connector_notices SET resolved_at = $3 WHERE account_id = $1 AND kind = $2 AND resolved_at IS NULL`,
    [accountId, kind, now.toISOString()],
  );
}

export interface OpenNotice {
  account_id: string;
  kind: NoticeKind;
  detail: string;
  created_at: string;
}

/**
 * Drop an account's cursors, items and notices once its pages are gone, so a
 * later reconnect backfills instead of skipping items it remembers storing.
 */
export async function forgetSyncState(engine: Engine, accountId: string): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.query(`DELETE FROM connector_items WHERE account_id = $1`, [accountId]);
    await tx.query(`DELETE FROM connector_cursors WHERE account_id = $1`, [accountId]);
    await tx.query(`DELETE FROM connector_notices WHERE account_id = $1`, [accountId]);
  });
}

export async function listOpenNotices(engine: Engine): Promise<OpenNotice[]> {
  const r = await engine.query<OpenNotice>(
    `SELECT account_id::text AS account_id, kind, detail, created_at::text AS created_at
       FROM connector_notices WHERE resolved_at IS NULL ORDER BY created_at, id`,
  );
  return r.rows;
}
