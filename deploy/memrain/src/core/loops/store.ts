/**
 * The open-loop store: thread states recorded by the connector sync, loops the
 * sweep concludes from them, and the owner's mutes and closes.
 *
 * One SQL text for both engines. A loop closes by changing its status, never
 * by deletion; `closed_by` is a short code (reply, owner, muted, unmuted,
 * page_deleted, expired, cancelled). Every read takes a source scope (source-scope.ts): the
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
/** Threads one sweep query reads at a time. */
const SWEEP_BATCH_THREADS = 500;
/** An open loop with no activity for this long goes stale, so it neither lingers in the list nor keeps its thread in every sweep. */
export const LOOP_STALE_DAYS = 90;

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
}

interface ThreadRow { page_slug: string; kind: string; thread_ref: string; signals: unknown; updated_at: unknown; deleted: boolean }

/**
 * One sweep of one source: re-judge every thread with recent activity (and
 * every thread that still has an open loop), close what stopped holding, open
 * what holds now. Threads are read in batches of whole threads, keyed by
 * thread ref, so a large source is covered in full and a conversation spread
 * over several day pages is always judged as one. Free: no model, no network.
 */
export async function sweepLoops(engine: Engine, sourceId: string, now: Date = new Date(), opts: { batchSize?: number } = {}): Promise<SweepResult> {
  const result: SweepResult = { threads: 0, opened: 0, closed: 0 };
  const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? SWEEP_BATCH_THREADS));
  // A page deleted (upstream, or by the owner) takes its loops out of the list.
  result.closed += await closeWhere(engine, sourceId,
    `page_slug IN (SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL)`, [], "dropped", "page_deleted");
  // Unanswered for months is not answered: it is stale, and says so. An RSVP
  // expires on its own when the meeting starts, however early it was sent.
  result.closed += await closeWhere(engine, sourceId, `loop_type <> 'rsvp_owed' AND last_activity_at < $2::timestamptz`,
    [new Date(now.getTime() - LOOP_STALE_DAYS * 86_400_000).toISOString()], "stale", "staleness");

  const since = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString();
  const suppress = await loadSuppressions(engine, sourceId);
  let after = "";
  for (;;) {
    const refs = (await engine.query<{ thread_ref: string }>(
      `SELECT DISTINCT t.thread_ref FROM loop_threads t
        WHERE t.source_id = $1 AND t.thread_ref > $3
          AND (t.last_activity_at >= $2::timestamptz
               OR t.thread_ref IN (SELECT thread_ref FROM open_loops
                                    WHERE source_id = $1 AND status = 'open' AND detector = 'deterministic' AND thread_ref IS NOT NULL))
        ORDER BY t.thread_ref
        LIMIT ${batchSize}`,
      [sourceId, since, after],
    )).rows.map(r => r.thread_ref);
    if (refs.length === 0) break;
    after = refs.at(-1)!;
    const rows = (await engine.query<ThreadRow>(
      `SELECT t.page_slug, t.kind, t.thread_ref, t.signals, t.updated_at, (p.deleted_at IS NOT NULL) AS deleted
         FROM loop_threads t JOIN pages p ON p.slug = t.page_slug
        WHERE t.source_id = $1 AND t.thread_ref = ANY($2::text[])
        ORDER BY t.thread_ref, t.last_activity_at`,
      [sourceId, refs],
    )).rows;
    await judgeThreads(engine, sourceId, rows, now, suppress, result);
  }
  return result;
}

/** Whole threads of one batch: judge each and apply its verdict. */
async function judgeThreads(engine: Engine, sourceId: string, rows: readonly ThreadRow[], now: Date, suppress: LoopSuppressions, result: SweepResult): Promise<void> {
  const groups = new Map<string, ThreadRow[]>();
  for (const row of rows) {
    if (row.deleted) continue;
    const key = `${row.kind}:${row.thread_ref}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const parsed = parseThreadRows(group);
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
    const { merged, latestPage } = mergeThread(parsed);
    const v = detectThread(merged, now, suppress);
    const desired = new Set(v.open.map(o => o.loopType));
    result.closed += await closeThread(engine, sourceId, merged.threadRef, v.close.filter(t => !desired.has(t)), "done", "reply");
    for (const o of v.open) if (await upsertLoop(engine, sourceId, merged.kind, merged.threadRef, latestPage, o)) result.opened++;
  }
}

type ParsedThreadRow = { row: ThreadRow; signals: LoopSignals };

function parseThreadRows(rows: readonly ThreadRow[]): ParsedThreadRow[] {
  return rows.map(r => ({ row: r, signals: typeof r.signals === "string" ? JSON.parse(r.signals) as unknown : r.signals }))
    .filter((x): x is ParsedThreadRow => isLoopSignals(x.signals));
}

/** One mail or chat conversation from all its pages: the merged signals and the page with the newest activity. */
function mergeThread(parsed: readonly ParsedThreadRow[]): { merged: ThreadLoopSignals; latestPage: string } {
  const threads = parsed.map(p => p.signals as ThreadLoopSignals);
  const merged = threads.length === 1 ? threads[0]! : mergeThreadSignals(threads);
  const latestPage = parsed.reduce((a, b) => (signalsActivityAt(b.signals) > signalsActivityAt(a.signals) ? b : a)).row.page_slug;
  return { merged, latestPage };
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
 * "done". Nothing is written for a page that is gone, or for a key muted
 * since the sweep read its suppressions (a mute closes loops concurrently).
 * A loop a mute closed is never reopened here, only by its unmute: on
 * Postgres the suppression check above can miss a mute still committing,
 * while the conflict update re-reads the row the mute closed.
 * True when the row was inserted or a closed one reopened.
 */
async function upsertLoop(engine: Engine, sourceId: string, kind: string, threadRef: string, pageSlug: string, o: LoopSpec): Promise<boolean> {
  const r = await engine.query<{ was_open: boolean | null }>(
    `WITH prev AS (SELECT status FROM open_loops WHERE source_id = $1 AND dedup_key = $2)
     INSERT INTO open_loops (source_id, dedup_key, loop_type, detector, kind, thread_ref, page_slug,
                             counterparty_label, counterparty_key, summary, evidence, due_at, opened_at, last_activity_at)
     SELECT $1, $2, $3, 'deterministic', $4, $5, p.slug, $6, $7, $8, $9::text::jsonb, $10::timestamptz, $11::timestamptz, $12::timestamptz
       FROM pages p WHERE p.slug = $13 AND p.source_id = $1 AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM loop_suppressions s WHERE s.source_id = $1
                         AND ((s.kind = 'sender' AND s.value_hash = $7) OR (s.kind = 'thread' AND s.value_hash = $5)))
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       opened_at = CASE WHEN open_loops.status = 'open' THEN LEAST(open_loops.opened_at, EXCLUDED.opened_at) ELSE EXCLUDED.opened_at END,
       status = 'open', page_slug = EXCLUDED.page_slug,
       counterparty_label = EXCLUDED.counterparty_label, counterparty_key = EXCLUDED.counterparty_key,
       summary = EXCLUDED.summary, evidence = EXCLUDED.evidence, due_at = EXCLUDED.due_at,
       last_activity_at = GREATEST(open_loops.last_activity_at, EXCLUDED.last_activity_at),
       closed_at = NULL, closed_by = NULL, updated_at = NOW()
     WHERE open_loops.status = 'open'
        OR (EXCLUDED.last_activity_at > open_loops.last_activity_at AND open_loops.closed_by IS DISTINCT FROM 'muted')
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
  return r.rows.map(toLoopRow);
}

const LOOP_COLUMNS = "id, source_id, loop_type, status, kind, summary, counterparty_label, page_slug, due_at, opened_at, last_activity_at, closed_at, closed_by";

function toLoopRow(row: Record<string, unknown>): OpenLoopRow {
  return {
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
  };
}

/**
 * The owner closes a loop (done or dropped). Null when no open loop with that
 * id is in scope. A dry run returns the loop as it is and writes nothing.
 */
export async function closeLoop(engine: Engine, scope: SourceScope, id: number, status: "done" | "dropped", opts: { dryRun?: boolean } = {}): Promise<OpenLoopRow | null> {
  const params: unknown[] = [id];
  const where = `WHERE id = $1 AND status = 'open'${andSourceScope("source_id", scope, params)}`;
  params.push(status);
  const r = await engine.query<Record<string, unknown>>(
    // scope: upstream `where` carries andSourceScope
    opts.dryRun
      ? `SELECT ${LOOP_COLUMNS} FROM open_loops ${where}`
      : `UPDATE open_loops SET status = $${params.length}, closed_at = NOW(), closed_by = 'owner', updated_at = NOW()
          ${where} RETURNING ${LOOP_COLUMNS}`,
    opts.dryRun ? params.slice(0, -1) : params,
  );
  return r.rows[0] ? toLoopRow(r.rows[0]) : null;
}

export type MuteKind = "sender" | "thread";

export interface MuteResult {
  source_id: string;
  kind: MuteKind;
  /** The suppression row was added (mute) or removed (unmute); on a dry run, would be. */
  changed: boolean;
  dry_run?: true;
  /** Mute: the reply-owed loops it closed (`would_close` on a dry run). */
  closed?: number[];
  would_close?: number[];
  /** Unmute: what became of each loop the mute had closed. */
  reopened?: number[];
  answered?: number[];
  stayed_muted?: number[];
  unverifiable?: number[];
}

interface MutedLoopRow { id: number; kind: string; thread_ref: string | null; counterparty_key: string | null }

type Recheck =
  | { outcome: "reopened"; page: string; spec: LoopSpec | undefined }
  /** `owedTo`: the reply is now owed to another muted sender, whose unmute brings it back. */
  | { outcome: "stayed_muted"; page?: string; owedTo?: LoopSpec }
  | { outcome: "answered" | "unverifiable" };

/**
 * Mute or unmute the sender or the thread of a loop, in its own source.
 *
 * A mute stops new loops opening for that key and closes its open reply-owed
 * (unanswered_inbound) loops as dropped with closed_by `muted`; other loop
 * types keep their state. An unmute re-judges each loop the mute closed from
 * the stored reply state, with the same live-page and merged-thread rules as
 * the sweep: answered since the mute closes it as done/reply, otherwise it
 * reopens. A loop another mute still covers stays closed, re-keyed to the
 * muted sender it is now owed to; one whose thread has no live page left
 * cannot be re-judged and stays closed (`unmuted`). Loops
 * the owner closed are never touched. Each change runs in one transaction,
 * serialized per source, so the suppression and the loops never disagree.
 */
export async function muteLoop(
  engine: Engine, scope: SourceScope, id: number, kind: MuteKind, mute: boolean,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<MuteResult | null> {
  const readLoop = async (e: Engine) => {
    const params: unknown[] = [id];
    return (await e.query<{ source_id: string; counterparty_key: string | null; thread_ref: string | null }>(
      `SELECT source_id, counterparty_key, thread_ref FROM open_loops WHERE id = $1${andSourceScope("source_id", scope, params)}`,
      params,
    )).rows[0];
  };
  const run = async (tx: Engine, row: { source_id: string; counterparty_key: string | null; thread_ref: string | null }): Promise<MuteResult> => {
    const value = kind === "sender" ? row.counterparty_key : row.thread_ref;
    if (value === null) {
      return { source_id: row.source_id, kind, changed: false, ...(mute
        ? opts.dryRun ? { would_close: [] } : { closed: [] }
        : { reopened: [], answered: [], stayed_muted: [], unverifiable: [] }) };
    }
    return mute
      ? applyMute(tx, row.source_id, kind, value, opts.dryRun === true)
      : applyUnmute(tx, row.source_id, kind, value, opts.now ?? new Date(), opts.dryRun === true);
  };
  const first = await readLoop(engine);
  if (!first) return null;
  if (opts.dryRun) return { ...await run(engine, first), dry_run: true };
  return engine.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memrain:loop-mutes:${first.source_id}`]);
    // Read the key again under the lock: an unmute that held it may have re-keyed the loop.
    const row = await readLoop(tx);
    return row ? run(tx, row) : null;
  });
}

const muteColumn = (kind: MuteKind) => (kind === "sender" ? "counterparty_key" : "thread_ref");
const ids = (rows: ReadonlyArray<{ id: unknown }>) => rows.map(x => Number(x.id)).sort((a, b) => a - b);

async function applyMute(tx: Engine, sourceId: string, kind: MuteKind, value: string, dryRun: boolean): Promise<MuteResult> {
  const covered = `source_id = $1 AND status = 'open' AND loop_type = 'unanswered_inbound' AND ${muteColumn(kind)} = $2`;
  if (dryRun) {
    const present = await tx.query(`SELECT 1 FROM loop_suppressions WHERE source_id = $1 AND kind = $2 AND value_hash = $3`, [sourceId, kind, value]);
    // scope: upstream `covered` pins source_id to the loop's own source
    const would = await tx.query<{ id: number }>(`SELECT id FROM open_loops WHERE ${covered}`, [sourceId, value]);
    return { source_id: sourceId, kind, changed: present.rows.length === 0, would_close: ids(would.rows) };
  }
  const added = await tx.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ($1, $2, $3)
                                ON CONFLICT DO NOTHING RETURNING value_hash`, [sourceId, kind, value]);
  const closed = await tx.query<{ id: number }>(
    `UPDATE open_loops SET status = 'dropped', closed_at = NOW(), closed_by = 'muted', updated_at = NOW() WHERE ${covered} RETURNING id`,
    [sourceId, value],
  );
  return { source_id: sourceId, kind, changed: added.rows.length > 0, closed: ids(closed.rows) };
}

async function applyUnmute(tx: Engine, sourceId: string, kind: MuteKind, value: string, now: Date, dryRun: boolean): Promise<MuteResult> {
  const removed = await tx.query(
    dryRun
      ? `SELECT value_hash FROM loop_suppressions WHERE source_id = $1 AND kind = $2 AND value_hash = $3`
      : `DELETE FROM loop_suppressions WHERE source_id = $1 AND kind = $2 AND value_hash = $3 RETURNING value_hash`,
    [sourceId, kind, value],
  );
  const left = await loadSuppressions(tx, sourceId);
  const suppress: LoopSuppressions = kind === "sender"
    ? { senders: new Set([...left.senders].filter(v => v !== value)), threads: left.threads }
    : { senders: left.senders, threads: new Set([...left.threads].filter(v => v !== value)) };
  const muted = await tx.query<MutedLoopRow>(
    `SELECT id, kind, thread_ref, counterparty_key FROM open_loops
      WHERE source_id = $1 AND status = 'dropped' AND closed_by = 'muted' AND loop_type = 'unanswered_inbound' AND ${muteColumn(kind)} = $2
      ORDER BY id`,
    [sourceId, value],
  );
  const result: MuteResult = { source_id: sourceId, kind, changed: removed.rows.length > 0, reopened: [], answered: [], stayed_muted: [], unverifiable: [] };
  for (const loop of muted.rows) {
    const check = await recheckMutedLoop(tx, sourceId, loop, now, suppress);
    result[check.outcome]!.push(Number(loop.id));
    if (!dryRun) await settleMutedLoop(tx, Number(loop.id), check);
  }
  return result;
}

/** Re-judge one mute-closed loop from its thread's stored reply state, on its live pages only. */
async function recheckMutedLoop(tx: Engine, sourceId: string, loop: MutedLoopRow, now: Date, suppress: LoopSuppressions): Promise<Recheck> {
  if ((loop.thread_ref !== null && suppress.threads.has(loop.thread_ref))
    || (loop.counterparty_key !== null && suppress.senders.has(loop.counterparty_key))) return { outcome: "stayed_muted" };
  if (loop.thread_ref === null) return { outcome: "unverifiable" };
  const rows = (await tx.query<ThreadRow>(
    `SELECT t.page_slug, t.kind, t.thread_ref, t.signals, t.updated_at, (p.deleted_at IS NOT NULL) AS deleted
       FROM loop_threads t JOIN pages p ON p.slug = t.page_slug
      WHERE t.source_id = $1 AND t.kind = $2 AND t.thread_ref = $3
      ORDER BY t.last_activity_at`,
    [sourceId, loop.kind, loop.thread_ref],
  )).rows;
  const parsed = parseThreadRows(rows.filter(r => !r.deleted)).filter(p => p.signals.kind !== "calendar");
  if (parsed.length === 0) return { outcome: "unverifiable" };
  const { merged, latestPage } = mergeThread(parsed);
  const v = detectThread(merged, now, suppress);
  const spec = v.open.find(o => o.loopType === "unanswered_inbound");
  // Only a reply of mine closes it, as in the sweep: grace, the open window
  // and list rules withhold a new loop but never fabricate an answer.
  if (!spec && v.close.includes("unanswered_inbound")) return { outcome: "answered" };
  if (!spec) {
    // Withheld only by a mute: someone else, still muted, wrote last.
    const owedTo = detectThread(merged, now, { senders: new Set(), threads: new Set() }).open.find(o => o.loopType === "unanswered_inbound");
    if (owedTo?.counterpartyKey && suppress.senders.has(owedTo.counterpartyKey)) return { outcome: "stayed_muted", page: latestPage, owedTo };
  }
  return { outcome: "reopened", page: latestPage, spec };
}

async function settleMutedLoop(tx: Engine, id: number, check: Recheck): Promise<void> {
  const guard = `WHERE id = $1 AND status = 'dropped' AND closed_by = 'muted'`;
  if (check.outcome === "stayed_muted") {
    if (check.owedTo) await setLoopCounterparty(tx, id, guard, check.page!, check.owedTo);
    return;
  }
  if (check.outcome !== "reopened") {
    if (check.outcome === "unverifiable") {
      await tx.query(`UPDATE open_loops SET closed_by = 'unmuted', updated_at = NOW() ${guard}`, [id]);
    } else if (check.outcome === "answered") {
      await tx.query(`UPDATE open_loops SET status = 'done', closed_at = NOW(), closed_by = 'reply', updated_at = NOW() ${guard}`, [id]);
    }
    return;
  }
  if (check.spec) await setLoopCounterparty(tx, id, guard, check.page, check.spec);
  await tx.query(`UPDATE open_loops SET status = 'open', closed_at = NULL, closed_by = NULL, page_slug = $2, updated_at = NOW() ${guard}`, [id, check.page]);
}

/** Point a mute-closed loop at whom and what it is owed now, as the sweep's upsert would. */
async function setLoopCounterparty(tx: Engine, id: number, guard: string, page: string, o: LoopSpec): Promise<void> {
  await tx.query(
    `UPDATE open_loops SET page_slug = $2, counterparty_label = $3, counterparty_key = $4, summary = $5, evidence = $6::text::jsonb,
            last_activity_at = GREATEST(last_activity_at, $7::timestamptz), updated_at = NOW() ${guard}`,
    [id, page, o.counterpartyLabel === null ? null : o.counterpartyLabel.slice(0, 300), o.counterpartyKey, o.summary,
      JSON.stringify([{ page_slug: page, at: o.evidenceAt }]), o.lastActivityAt],
  );
}

/** A loop list is stale when no mail, chat or calendar account synced cleanly for this long. */
export const LOOPS_MAX_SYNC_AGE_HOURS = 24;

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
