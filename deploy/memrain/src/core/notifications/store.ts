/**
 * Owner notifications (migration 160): pointers to problems the brain already
 * records elsewhere, so the owner hears about them without opening doctor.
 *
 * Nothing calls `notify()` from the code that finds a problem. Each problem
 * already lives in its own table — a connector account waiting for a
 * reconnect, a connector notice, an open spend-path pause, a daemon the
 * scheduler auto-paused, a write-gate hold awaiting review — and
 * `syncNotifications` reconciles the open notifications against them. That
 * keeps "one problem, one notification" true by construction: the dedupe key
 * is the problem's own identity (kind + ref), an open row exists exactly
 * while the problem does, and a relapse soon after it was resolved reopens the
 * same row instead of adding another.
 *
 * A notification holds no content: kind, ref, source and timestamps only. The
 * problem's own detail (an error message, a subject line, an address) stays
 * in its table, behind the admin session.
 *
 * Reads here cover every source: notifications are an operator surface (the
 * admin list, doctor and the operator's webhook).
 */
import type { Engine } from "../engine/interface.ts";

export const NOTIFICATION_KINDS = [
  "needs_reconnect",
  "deletions_held",
  "items_held",
  "spend_path_paused",
  "daemon_auto_paused",
  "write_gate_hold",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type WebhookState = "off" | "pending" | "delivered" | "failed" | "cancelled";

/** A problem as its own table records it. */
export interface Problem {
  kind: NotificationKind;
  /** The problem's identity within its kind: an account id, `daemon:source`, a spend path, a source id. */
  ref: string;
  /** The source the problem is about; brain-wide problems belong to `default`. */
  source_id: string;
}

export interface NotificationRow {
  id: number;
  source_id: string;
  kind: NotificationKind;
  ref: string;
  link: string;
  created_at: string;
  reopened_at: string | null;
  resolved_at: string | null;
  read_at: string | null;
  webhook_state: WebhookState;
  webhook_attempts: number;
  webhook_delivered_at: string | null;
  webhook_error: string | null;
}

export interface SyncResult {
  opened: number;
  reopened: number;
  resolved: number;
}

/** A problem back within this long of being resolved reopens its notification. */
export const REOPEN_WITHIN_MS = 3_600_000;
const DEFAULT_RETENTION_DAYS = 30;
const LOCK_KEY = "memrain:notifications";
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

/** Where the admin SPA shows one notification. */
export function notificationLink(id: number): string {
  return `/admin#notifications/${id}`;
}

/** MEMRAIN_NOTIFICATIONS_RETENTION_DAYS, a positive integer (default 30). */
export function notificationRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MEMRAIN_NOTIFICATIONS_RETENTION_DAYS ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * Every problem open right now. Read-only, so doctor can call it.
 *
 * A needs_reconnect problem is the account's own status or the sync engine's
 * open notice for it; both name the account, so they are one problem.
 */
export async function currentProblems(engine: Engine): Promise<Problem[]> {
  // scope: operator-only notifications are the operator's view of every source's problems
  const r = await engine.query<Problem>(
    `SELECT 'needs_reconnect' AS kind, a.id::text AS ref, a.source_id
       FROM connector_accounts a
      WHERE a.status = 'needs_reconnect'
         OR EXISTS (SELECT 1 FROM connector_notices n
                     WHERE n.account_id = a.id AND n.kind = 'needs_reconnect' AND n.resolved_at IS NULL)
     UNION ALL
     SELECT CASE n.kind WHEN 'mass_delete_held' THEN 'deletions_held' ELSE 'items_held' END, a.id::text, a.source_id
       FROM connector_notices n JOIN connector_accounts a ON a.id = n.account_id
      WHERE n.resolved_at IS NULL AND n.kind IN ('mass_delete_held', 'items_held')
     UNION ALL
     SELECT 'spend_path_paused', p.path, 'default' FROM spend_path_pauses p WHERE p.resolved_at IS NULL
     UNION ALL
     SELECT 'daemon_auto_paused', c.daemon || ':' || c.source_id, COALESCE(s.id, 'default')
       FROM daemon_controls c LEFT JOIN sources s ON s.id = c.source_id
      WHERE c.paused AND c.paused_by = 'auto' AND (c.source_id = '*' OR s.id IS NOT NULL)
     UNION ALL
     SELECT 'write_gate_hold', h.source_id, h.source_id
       FROM write_gate_holds h WHERE h.decision IS NULL GROUP BY h.source_id
     ORDER BY 1, 2`,
  );
  return r.rows.map(p => ({ kind: p.kind, ref: p.ref, source_id: p.source_id }));
}

const key = (kind: string, ref: string) => `${kind}\u0000${ref}`;

export interface SyncOptions {
  now?: Date;
  /** Queue a webhook delivery for notifications this sync opens. */
  webhook?: boolean;
}

/**
 * Reconcile open notifications with the problems open right now. One sync at
 * a time per database (a transaction-scoped advisory lock), so two syncs never
 * resolve and reopen each other's rows.
 */
export async function syncNotifications(engine: Engine, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = (opts.now ?? new Date()).toISOString();
  const reopenAfter = new Date(Date.parse(now) - REOPEN_WITHIN_MS).toISOString();
  const queued: WebhookState = opts.webhook === true ? "pending" : "off";
  return engine.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const problems = await currentProblems(tx);
    const wanted = new Map(problems.map(p => [key(p.kind, p.ref), p]));
    // scope: operator-only reconciling covers every source's notifications
    const openRows = (await tx.query<{ id: number | string; kind: string; ref: string }>(
      `SELECT id, kind, ref FROM notifications WHERE resolved_at IS NULL`,
    )).rows;
    const result: SyncResult = { opened: 0, reopened: 0, resolved: 0 };

    const gone = openRows.filter(r => !wanted.has(key(r.kind, r.ref))).map(r => Number(r.id));
    if (gone.length > 0) {
      const r = await tx.query(
        `UPDATE notifications
            SET resolved_at = $2,
                webhook_state = CASE WHEN webhook_state = 'pending' THEN 'cancelled' ELSE webhook_state END,
                webhook_next_at = NULL, webhook_lease_until = NULL
          WHERE id = ANY($1::bigint[]) AND resolved_at IS NULL
          RETURNING id`,
        [gone, now],
      );
      result.resolved = r.rows.length;
    }

    const already = new Set(openRows.map(r => key(r.kind, r.ref)));
    for (const p of problems) {
      if (already.has(key(p.kind, p.ref))) continue;
      // A relapse keeps a delivered webhook as sent (one problem, one message),
      // but one the owner never received — cancelled or failed — is queued again.
      // scope: operator-only reopening is the reconciler's own bookkeeping; the row must belong to the problem's source
      const reopened = await tx.query(
        `UPDATE notifications
            SET resolved_at = NULL, reopened_at = $4, read_at = NULL,
                webhook_state = CASE WHEN webhook_state = 'cancelled' THEN $5
                                     WHEN webhook_state = 'failed' AND $5 = 'pending' THEN 'pending'
                                     ELSE webhook_state END,
                webhook_next_at = CASE WHEN webhook_state IN ('cancelled', 'failed') AND $5 = 'pending' THEN $4::timestamptz ELSE webhook_next_at END,
                webhook_attempts = CASE WHEN webhook_state = 'failed' AND $5 = 'pending' THEN 0 ELSE webhook_attempts END,
                webhook_error = CASE WHEN webhook_state = 'failed' AND $5 = 'pending' THEN NULL ELSE webhook_error END
          WHERE id = (SELECT id FROM notifications
                       WHERE kind = $1 AND ref = $2 AND source_id = $6 AND resolved_at IS NOT NULL AND resolved_at > $3
                       ORDER BY resolved_at DESC, id DESC LIMIT 1)
          RETURNING id`,
        [p.kind, p.ref, reopenAfter, now, queued, p.source_id],
      );
      if (reopened.rows.length > 0) {
        result.reopened++;
        continue;
      }
      const inserted = await tx.query(
        `INSERT INTO notifications (source_id, kind, ref, created_at, webhook_state, webhook_next_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'pending' THEN $4::timestamptz END)
         ON CONFLICT (kind, ref) WHERE resolved_at IS NULL DO NOTHING
         RETURNING id`,
        [p.source_id, p.kind, p.ref, now, queued],
      );
      result.opened += inserted.rows.length;
    }
    return result;
  });
}

interface RawRow extends Omit<NotificationRow, "id" | "link" | "webhook_attempts"> {
  id: number | string;
  webhook_attempts: number | string;
}

const ROW_COLS = `id, source_id, kind, ref, created_at::text AS created_at, reopened_at::text AS reopened_at,
  resolved_at::text AS resolved_at, read_at::text AS read_at, webhook_state, webhook_attempts,
  webhook_delivered_at::text AS webhook_delivered_at, webhook_error`;

function toRow(r: RawRow): NotificationRow {
  const id = Number(r.id);
  return { ...r, id, link: notificationLink(id), webhook_attempts: Number(r.webhook_attempts) };
}

export interface ListOptions {
  includeResolved?: boolean;
  limit?: number;
}

/** Newest first; open ones only unless `includeResolved`. */
export async function listNotifications(engine: Engine, opts: ListOptions = {}): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  // scope: operator-only the admin list shows every source's notifications
  const r = await engine.query<RawRow>(
    `SELECT ${ROW_COLS} FROM notifications
      WHERE $1::boolean OR resolved_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [opts.includeResolved === true, limit],
  );
  return r.rows.map(toRow);
}

export interface NotificationSummary {
  open: number;
  unread: number;
  by_kind: Partial<Record<NotificationKind, number>>;
}

/** Counts for the admin badge: open notifications, unread ones, and open ones by kind. */
export async function notificationSummary(engine: Engine): Promise<NotificationSummary> {
  // scope: operator-only the admin badge counts every source's open notifications
  const r = await engine.query<{ kind: NotificationKind; open: number | string; unread: number | string }>(
    `SELECT kind, count(*)::int AS open, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
       FROM notifications WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind`,
  );
  const summary: NotificationSummary = { open: 0, unread: 0, by_kind: {} };
  for (const row of r.rows) {
    summary.open += Number(row.open);
    summary.unread += Number(row.unread);
    summary.by_kind[row.kind] = Number(row.open);
  }
  return summary;
}

/** Mark notifications read; `"all"` marks every unread one. Returns how many changed. */
export async function markNotificationsRead(engine: Engine, ids: readonly number[] | "all", now: Date = new Date()): Promise<number> {
  if (ids !== "all" && ids.length === 0) return 0;
  const r = ids === "all"
    ? await engine.query(`UPDATE notifications SET read_at = $1 WHERE read_at IS NULL RETURNING id`, [now.toISOString()])
    : await engine.query(
        `UPDATE notifications SET read_at = $2 WHERE id = ANY($1::bigint[]) AND read_at IS NULL RETURNING id`,
        [[...ids], now.toISOString()],
      );
  return r.rows.length;
}

/** Delete notifications resolved more than `retentionDays` ago. Open ones always stay. */
export async function purgeResolvedNotifications(engine: Engine, now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const r = await engine.query(
    `DELETE FROM notifications WHERE resolved_at IS NOT NULL AND resolved_at < $1 RETURNING id`,
    [cutoff],
  );
  return r.rows.length;
}
