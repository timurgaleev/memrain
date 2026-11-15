/**
 * The open-loop store: thread states recorded by the connector sync, loops the
 * sweep concludes from them, and the owner's mutes and closes.
 *
 * One SQL text for both engines. A loop closes by changing its status, never
 * by deletion; `closed_by` is a short code (reply, owner, page_deleted,
 * expired, cancelled). Every read takes a source scope (source-scope.ts): the
 * operator passes none, a caller with no grant reads nothing.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope, type SourceScope } from "../source-scope.ts";
import { detectCalendar, detectThread, LOOP_TYPES, type LoopSpec, type LoopSuppressions, type LoopType } from "./detect.ts";
import { isLoopSignals, mergeThreadSignals, signalsActivityAt, type LoopSignals, type ThreadLoopSignals } from "./signals.ts";

export type LoopStatus = "open" | "done" | "dropped" | "stale";
export const LOOP_STATUSES: readonly LoopStatus[] = ["open", "done", "dropped", "stale"];

export interface OpenLoopRow {
  id: number;
  source_id: string;
  loop_type: LoopType;
  status: LoopStatus;
  kind: string;
  summary: string;
  counterparty: string | null;
  page_slug: string | null;
  due_at: string | null;
  opened_at: string;
  last_activity_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : String(v);
};

/** Thread states with any activity this recent are swept. */
const SWEEP_WINDOW_DAYS = 17;
/** Most thread states one sweep reads for one source. */
export const MAX_SWEEP_THREADS = 5000;

/**
 * Remember an item's reply state once its page is stored. The row is written
 * only while the page exists in `sourceId`, and its change time moves only
 * when the state itself changed.
 */
export async function recordLoopThread(engine: Engine, input: { sourceId: string; slug: string; signals: LoopSignals }): Promise<boolean> {
  const s = input.signals;
  const r = await engine.query<{ page_slug: string }>(
    `INSERT INTO loop_threads (page_slug, source_id, kind, thread_ref, signals, last_activity_at)
     SELECT p.slug, p.source_id, $3, $4, $5::text::jsonb, $6::timestamptz FROM pages p
      WHERE p.slug = $1 AND p.source_id = $2
     ON CONFLICT (page_slug) DO UPDATE SET
       kind = EXCLUDED.kind, thread_ref = EXCLUDED.thread_ref, signals = EXCLUDED.signals,
       last_activity_at = EXCLUDED.last_activity_at, updated_at = NOW()
     WHERE loop_threads.source_id = EXCLUDED.source_id AND loop_threads.signals IS DISTINCT FROM EXCLUDED.signals
     RETURNING page_slug`,
    [input.slug, input.sourceId, s.kind, s.threadRef, JSON.stringify(s), signalsActivityAt(s)],
  );
  return r.rows.length > 0;
}

export async function loadSuppressions(engine: Engine, sourceId: string): Promise<LoopSuppressions> {
  const r = await engine.query<{ kind: string; value_hash: string }>(
    `SELECT kind, value_hash FROM loop_suppressions WHERE source_id = $1`, [sourceId]);
  return {
    senders: new Set(r.rows.filter(x => x.kind === "sender").map(x => x.value_hash)),
    threads: new Set(r.rows.filter(x => x.kind === "thread").map(x => x.value_hash)),
  };
}

export interface SweepResult {
  threads: number;
  opened: number;
  closed: number;
  /** Thread states past the per-run limit, left for the next sweep. */
  truncated: boolean;
}

interface ThreadRow { page_slug: string; kind: string; thread_ref: string; signals: unknown; updated_at: unknown; deleted: boolean }

/**
 * One sweep of one source: re-judge every thread state with recent activity
 * (and every thread that still has an open loop), close what stopped holding,
 * open what holds now. Free: no model and no network.
 */
export async function sweepLoops(engine: Engine, sourceId: string, now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { threads: 0, opened: 0, closed: 0, truncated: false };
  // A page deleted (upstream, or by the owner) takes its loops out of the list.
  result.closed += await closeWhere(engine, sourceId,
    `page_slug IN (SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL)`, [], "dropped", "page_deleted");

  const since = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = (await engine.query<ThreadRow>(
    `SELECT t.page_slug, t.kind, t.thread_ref, t.signals, t.updated_at, (p.deleted_at IS NOT NULL) AS deleted
       FROM loop_threads t JOIN pages p ON p.slug = t.page_slug
      WHERE t.source_id = $1
        AND (t.last_activity_at >= $2::timestamptz
             OR t.thread_ref IN (SELECT thread_ref FROM open_loops
                                  WHERE source_id = $1 AND status = 'open' AND detector = 'deterministic' AND thread_ref IS NOT NULL))
      ORDER BY t.last_activity_at DESC
      LIMIT ${MAX_SWEEP_THREADS + 1}`,
    [sourceId, since],
  )).rows;
  if (rows.length > MAX_SWEEP_THREADS) {
    result.truncated = true;
    rows.length = MAX_SWEEP_THREADS;
  }
  const suppress = await loadSuppressions(engine, sourceId);

  const groups = new Map<string, ThreadRow[]>();
  for (const row of rows) {
    if (row.deleted) continue;
    const key = `${row.kind}:${row.thread_ref}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const parsed = group.map(r => ({ row: r, signals: typeof r.signals === "string" ? JSON.parse(r.signals) as unknown : r.signals }))
      .filter((x): x is { row: ThreadRow; signals: LoopSignals } => isLoopSignals(x.signals));
    if (parsed.length === 0) continue;
    result.threads++;
    const first = parsed[0]!;
    if (first.signals.kind === "calendar") {
      const changedAt = toIso(first.row.updated_at) ?? now.toISOString();
      const v = detectCalendar(first.signals, now, suppress, changedAt);
      const closedBy = v.closedBy ?? "reply";
      const status: LoopStatus = closedBy === "expired" ? "stale" : closedBy === "cancelled" ? "dropped" : "done";
      result.closed += await closeThread(engine, sourceId, first.signals.threadRef, v.close, status, closedBy);
      for (const o of v.open) if (await upsertLoop(engine, sourceId, "calendar", first.signals.threadRef, first.row.page_slug, o)) result.opened++;
      continue;
    }
    const threads = parsed.map(p => p.signals as ThreadLoopSignals);
    const merged = threads.length === 1 ? threads[0]! : mergeThreadSignals(threads);
    const latestPage = parsed.reduce((a, b) => (signalsActivityAt(b.signals) > signalsActivityAt(a.signals) ? b : a)).row.page_slug;
    const v = detectThread(merged, now, suppress);
    const desired = new Set(v.open.map(o => o.loopType));
    result.closed += await closeThread(engine, sourceId, merged.threadRef, v.close.filter(t => !desired.has(t)), "done", "reply");
    for (const o of v.open) if (await upsertLoop(engine, sourceId, merged.kind, merged.threadRef, latestPage, o)) result.opened++;
  }
  return result;
}

async function closeWhere(engine: Engine, sourceId: string, where: string, params: unknown[], status: LoopStatus, closedBy: string): Promise<number> {
  const r = await engine.query<{ id: number }>(
    `UPDATE open_loops SET status = '${status}', closed_at = NOW(), closed_by = '${closedBy}', updated_at = NOW()
      WHERE source_id = $1 AND status = 'open' AND detector = 'deterministic' AND ${where} RETURNING id`,
    [sourceId, ...params],
  );
  return r.rows.length;
}

async function closeThread(engine: Engine, sourceId: string, threadRef: string, types: readonly LoopType[], status: LoopStatus, closedBy: string): Promise<number> {
  if (types.length === 0) return 0;
  return closeWhere(engine, sourceId, `thread_ref = $2 AND loop_type = ANY($3::text[])`, [threadRef, [...types]], status, closedBy);
}

/**
 * Open (or keep open) one loop. A loop someone closed reopens only on newer
 * activity, so a re-sync of an unchanged thread never undoes the owner's
 * "done". Nothing is written for a page that is gone. True when the row was
 * inserted or a closed one reopened.
 */
async function upsertLoop(engine: Engine, sourceId: string, kind: string, threadRef: string, pageSlug: string, o: LoopSpec): Promise<boolean> {
  const r = await engine.query<{ was_open: boolean | null }>(
    `WITH prev AS (SELECT status FROM open_loops WHERE source_id = $1 AND dedup_key = $2)
     INSERT INTO open_loops (source_id, dedup_key, loop_type, detector, kind, thread_ref, page_slug,
                             counterparty_label, counterparty_key, summary, evidence, due_at, opened_at, last_activity_at)
     SELECT $1, $2, $3, 'deterministic', $4, $5, p.slug, $6, $7, $8, $9::text::jsonb, $10::timestamptz, $11::timestamptz, $12::timestamptz
       FROM pages p WHERE p.slug = $13 AND p.source_id = $1 AND p.deleted_at IS NULL
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       opened_at = CASE WHEN open_loops.status = 'open' THEN LEAST(open_loops.opened_at, EXCLUDED.opened_at) ELSE EXCLUDED.opened_at END,
       status = 'open', page_slug = EXCLUDED.page_slug,
       counterparty_label = EXCLUDED.counterparty_label, counterparty_key = EXCLUDED.counterparty_key,
       summary = EXCLUDED.summary, evidence = EXCLUDED.evidence, due_at = EXCLUDED.due_at,
       last_activity_at = GREATEST(open_loops.last_activity_at, EXCLUDED.last_activity_at),
       closed_at = NULL, closed_by = NULL, updated_at = NOW()
     WHERE open_loops.status = 'open' OR EXCLUDED.last_activity_at > open_loops.last_activity_at
     RETURNING (SELECT status = 'open' FROM prev) AS was_open`,
    [
      sourceId, `${kind}:${threadRef}:${o.loopType}`, o.loopType, kind, threadRef,
      o.counterpartyLabel === null ? null : o.counterpartyLabel.slice(0, 300), o.counterpartyKey, o.summary,
      JSON.stringify([{ page_slug: pageSlug, at: o.evidenceAt }]), o.dueAt ?? null, o.openedAt, o.lastActivityAt, pageSlug,
    ],
  );
  return r.rows.length > 0 && r.rows[0]!.was_open !== true;
}

export interface ListLoopsOptions {
  status?: LoopStatus | "all";
  loopType?: LoopType;
  limit?: number;
}

/** Loops in the caller's sources, most recent activity first. */
export async function listLoops(engine: Engine, scope: SourceScope, opts: ListLoopsOptions = {}): Promise<OpenLoopRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
  const params: unknown[] = [];
  const where: string[] = ["(l.page_slug IS NULL OR p.deleted_at IS NULL)"];
  const status = opts.status ?? "open";
  if (status !== "all") {
    params.push(status);
    where.push(`l.status = $${params.length}`);
  }
  if (opts.loopType) {
    params.push(opts.loopType);
    where.push(`l.loop_type = $${params.length}`);
  }
  const scoped = andSourceScope("l.source_id", scope, params);
  const r = await engine.query<Record<string, unknown>>(
    `SELECT l.id, l.source_id, l.loop_type, l.status, l.kind, l.summary, l.counterparty_label, l.page_slug,
            l.due_at, l.opened_at, l.last_activity_at, l.closed_at, l.closed_by
       FROM open_loops l LEFT JOIN pages p ON p.slug = l.page_slug
      WHERE ${where.join(" AND ")}${scoped}
      ORDER BY l.last_activity_at DESC, l.id DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.map(row => ({
    id: Number(row["id"]),
    source_id: String(row["source_id"]),
    loop_type: row["loop_type"] as LoopType,
    status: row["status"] as LoopStatus,
    kind: String(row["kind"]),
    summary: String(row["summary"]),
    counterparty: (row["counterparty_label"] as string | null) ?? null,
    page_slug: (row["page_slug"] as string | null) ?? null,
    due_at: toIso(row["due_at"]),
    opened_at: toIso(row["opened_at"])!,
    last_activity_at: toIso(row["last_activity_at"])!,
    closed_at: toIso(row["closed_at"]),
    closed_by: (row["closed_by"] as string | null) ?? null,
  }));
}

/** The owner closes a loop (done or dropped). Null when no open loop with that id is in scope. */
export async function closeLoop(engine: Engine, scope: SourceScope, id: number, status: "done" | "dropped"): Promise<OpenLoopRow | null> {
  const params: unknown[] = [id, status];
  const r = await engine.query<{ id: number }>(
    `UPDATE open_loops SET status = $2, closed_at = NOW(), closed_by = 'owner', updated_at = NOW()
      WHERE id = $1 AND status = 'open'${andSourceScope("source_id", scope, params)} RETURNING id`,
    params,
  );
  if (r.rows.length === 0) return null;
  return (await listLoops(engine, scope, { status: "all", limit: 500 })).find(l => l.id === id) ?? null;
}

export type MuteKind = "sender" | "thread";

/**
 * Mute the sender or the thread of a loop: new loops stop opening for it.
 * The loop itself, and every other existing loop, stays as it is.
 */
export async function muteLoop(engine: Engine, scope: SourceScope, id: number, kind: MuteKind, mute: boolean): Promise<{ source_id: string; kind: MuteKind; changed: boolean } | null> {
  const params: unknown[] = [id];
  const r = await engine.query<{ source_id: string; counterparty_key: string | null; thread_ref: string | null }>(
    `SELECT source_id, counterparty_key, thread_ref FROM open_loops WHERE id = $1${andSourceScope("source_id", scope, params)}`,
    params,
  );
  const row = r.rows[0];
  if (!row) return null;
  const value = kind === "sender" ? row.counterparty_key : row.thread_ref;
  if (value === null) return { source_id: row.source_id, kind, changed: false };
  const changed = mute
    ? await engine.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ($1, $2, $3)
                          ON CONFLICT DO NOTHING RETURNING value_hash`, [row.source_id, kind, value])
    : await engine.query(`DELETE FROM loop_suppressions WHERE source_id = $1 AND kind = $2 AND value_hash = $3
                          RETURNING value_hash`, [row.source_id, kind, value]);
  return { source_id: row.source_id, kind, changed: changed.rows.length > 0 };
}

/** Source kinds whose connector pages carry reply state. */
export const LOOP_SOURCE_KINDS: readonly string[] = ["mailbox", "chat", "calendar"];

export interface SyncFreshness {
  /** Newest clean sync among enabled mail, chat and calendar accounts; null when none ever synced. */
  newest: string | null;
  accounts: number;
  /** Accounts whose last clean sync is older than the limit (or never happened). */
  stale: Array<{ source_id: string; provider: string; status: string; last_success_at: string | null }>;
}

export async function syncFreshness(engine: Engine, scope: SourceScope, now: Date, maxAgeHours: number): Promise<SyncFreshness> {
  const params: unknown[] = [[...LOOP_SOURCE_KINDS]];
  const r = await engine.query<{ source_id: string; provider: string; status: string; last_success_at: unknown }>(
    `SELECT a.source_id, a.provider, a.status, a.last_success_at
       FROM connector_accounts a JOIN sources s ON s.id = a.source_id
      WHERE a.enabled AND s.kind = ANY($1::text[])${andSourceScope("a.source_id", scope, params)}
      ORDER BY a.source_id, a.provider`,
    params,
  );
  const limit = now.getTime() - maxAgeHours * 3_600_000;
  const rows = r.rows.map(x => ({ ...x, last_success_at: toIso(x.last_success_at) }));
  const times = rows.map(x => x.last_success_at).filter((t): t is string => t !== null).sort();
  return {
    newest: times.at(-1) ?? null,
    accounts: rows.length,
    stale: rows.filter(x => x.last_success_at === null || Date.parse(x.last_success_at) < limit),
  };
}

export function isLoopType(value: unknown): value is LoopType {
  return typeof value === "string" && (LOOP_TYPES as readonly string[]).includes(value);
}
