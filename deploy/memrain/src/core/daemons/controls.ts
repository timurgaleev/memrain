/**
 * Reads and writes of `daemon_controls` (migration 155): pauses, overrides and
 * the status the scheduler and the cycle loop leave behind.
 *
 * Kill switches, coarsest first:
 *   MEMRAIN_DAEMONS=1        the scheduler runs at all (read every tick);
 *   MEMRAIN_DAEMONS_DISABLED a comma list of daemon names the env switches off;
 *   row ('*', '*')           every daemon paused;
 *   row (name, '*')          one daemon paused for every source;
 *   row (name, source)       one daemon paused for one source.
 */
import type { Engine } from "../engine/interface.ts";
import { appendAudit, auditDir } from "../audit-week-file.ts";

export const ALL = "*";
/** Failed runs in a row after which the scheduler pauses a daemon. */
export const AUTO_PAUSE_AFTER_FAILURES = 5;
export const AUTO_PAUSE_REASON = "auto:failures";
const MAX_REASON_CHARS = 200;

export interface DaemonControlRow {
  daemon: string;
  source_id: string;
  enabled: boolean | null;
  paused: boolean;
  paused_reason: string | null;
  paused_by: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  cron: string | null;
  timezone: string | null;
  consecutive_failures: number;
  last_window: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
}

export interface ResolvedControl {
  /** The row whose pause applies, broadest first; null when none does. */
  pausedBy: DaemonControlRow | null;
  enabled: boolean | null;
  cron: string | null;
  timezone: string | null;
  /** Where the failure count starts: the latest resume of this daemon. */
  resumedAt: string | null;
  lastWindow: string | null;
}

export interface EnvSwitches {
  on: boolean;
  disabled: ReadonlySet<string>;
}

export function envSwitches(env: NodeJS.ProcessEnv = process.env): EnvSwitches {
  return {
    on: env.MEMRAIN_DAEMONS?.trim() === "1",
    disabled: new Set((env.MEMRAIN_DAEMONS_DISABLED ?? "").split(",").map(s => s.trim()).filter(Boolean)),
  };
}

const COLS = `daemon, source_id, enabled, paused, paused_reason, paused_by,
  paused_at::text AS paused_at, resumed_at::text AS resumed_at, cron, timezone,
  consecutive_failures, last_window, last_run_at::text AS last_run_at, last_outcome`;

export async function readControls(engine: Engine): Promise<DaemonControlRow[]> {
  // scope: operator-only the scheduler tick and the operator's daemons_status read every source's controls
  const r = await engine.query<DaemonControlRow>(`SELECT ${COLS} FROM daemon_controls ORDER BY daemon, source_id`);
  return r.rows.map(row => ({ ...row, consecutive_failures: Number(row.consecutive_failures) }));
}

/** The rows that bear on one daemon for one source. */
export async function readControlsFor(engine: Engine, daemon: string, sourceId: string = ALL): Promise<DaemonControlRow[]> {
  const r = await engine.query<DaemonControlRow>(
    `SELECT ${COLS} FROM daemon_controls
      WHERE (daemon = '*' AND source_id = '*') OR (daemon = $1 AND source_id IN ('*', $2))`,
    [daemon, sourceId],
  );
  return r.rows.map(row => ({ ...row, consecutive_failures: Number(row.consecutive_failures) }));
}

export function resolveControl(rows: readonly DaemonControlRow[], daemon: string, sourceId: string): ResolvedControl {
  const find = (d: string, s: string) => rows.find(r => r.daemon === d && r.source_id === s);
  const global = find(ALL, ALL);
  const wide = find(daemon, ALL);
  const exact = sourceId === ALL ? undefined : find(daemon, sourceId);
  const pausedBy = [global, wide, exact].find(r => r?.paused) ?? null;
  return {
    pausedBy,
    enabled: exact?.enabled ?? wide?.enabled ?? null,
    cron: exact?.cron ?? wide?.cron ?? null,
    timezone: exact?.timezone ?? wide?.timezone ?? null,
    resumedAt: latest(exact?.resumed_at, wide?.resumed_at, global?.resumed_at),
    lastWindow: (exact ?? (sourceId === ALL ? wide : undefined))?.last_window ?? null,
  };
}

function latest(...values: (string | null | undefined)[]): string | null {
  const present = values.filter((v): v is string => typeof v === "string");
  if (present.length === 0) return null;
  return present.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function audit(record: Record<string, unknown>): void {
  const dir = auditDir();
  if (dir) appendAudit(dir, { kind: "daemon_control", ...record, at: new Date().toISOString() });
}

export interface ControlTarget {
  daemon: string;
  sourceId?: string;
  /** Channel that asked: cli, mcp, admin. */
  by: string;
}

export async function pauseDaemon(engine: Engine, t: ControlTarget & { reason?: string }): Promise<void> {
  const reason = t.reason?.trim().slice(0, MAX_REASON_CHARS) || null;
  await engine.query(
    `INSERT INTO daemon_controls (daemon, source_id, paused, paused_reason, paused_by, paused_at, updated_at)
     VALUES ($1, $2, true, $3, $4, NOW(), NOW())
     ON CONFLICT (daemon, source_id) DO UPDATE
       SET paused = true, paused_reason = $3, paused_by = $4, paused_at = NOW(), updated_at = NOW()`,
    [t.daemon, t.sourceId ?? ALL, reason, t.by],
  );
  audit({ action: "pause", daemon: t.daemon, source_id: t.sourceId ?? ALL, by: t.by, reason });
}

/**
 * Lift a pause; the failure count starts again from now. Naming a daemon
 * without a source lifts its pauses for every source, the scheduler's
 * per-source auto-pauses included; `*` lifts only the global pause.
 */
export async function resumeDaemon(engine: Engine, t: ControlTarget): Promise<void> {
  const lift = `paused = false, paused_reason = NULL, paused_by = NULL, paused_at = NULL,
           resumed_at = NOW(), consecutive_failures = 0, updated_at = NOW()`;
  await engine.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO daemon_controls (daemon, source_id, paused, resumed_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (daemon, source_id) DO UPDATE SET ${lift}`,
      [t.daemon, t.sourceId ?? ALL],
    );
    if (t.sourceId === undefined && t.daemon !== ALL) {
      await tx.query(`UPDATE daemon_controls SET ${lift} WHERE daemon = $1 AND source_id <> '*' AND paused`, [t.daemon]);
    }
  });
  audit({ action: "resume", daemon: t.daemon, source_id: t.sourceId ?? ALL, by: t.by });
}

/**
 * Switch a daemon on or off for every source, or for one source, which
 * overrides the daemon-wide switch there. Unlike a pause it is the daemon's
 * configured state, not an interruption: resume does not lift it.
 */
export async function setDaemonEnabled(engine: Engine, t: ControlTarget & { enabled: boolean }): Promise<void> {
  await engine.query(
    `INSERT INTO daemon_controls (daemon, source_id, enabled, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (daemon, source_id) DO UPDATE SET enabled = $3, updated_at = NOW()`,
    [t.daemon, t.sourceId ?? ALL, t.enabled],
  );
  audit({ action: t.enabled ? "enable" : "disable", daemon: t.daemon, source_id: t.sourceId ?? ALL, by: t.by });
}

/** Pause after repeated failures. True only for the call that paused it. */
export async function autoPause(engine: Engine, daemon: string, sourceId: string, failures: number): Promise<boolean> {
  const r = await engine.query<{ daemon: string }>(
    `INSERT INTO daemon_controls (daemon, source_id, paused, paused_reason, paused_by, paused_at, consecutive_failures, updated_at)
     VALUES ($1, $2, true, $3, 'auto', NOW(), $4, NOW())
     ON CONFLICT (daemon, source_id) DO UPDATE
       SET paused = true, paused_reason = $3, paused_by = 'auto', paused_at = NOW(),
           consecutive_failures = $4, updated_at = NOW()
       WHERE daemon_controls.paused = false
     RETURNING daemon`,
    [daemon, sourceId, AUTO_PAUSE_REASON, failures],
  );
  const paused = r.rows.length > 0;
  if (paused) audit({ action: "auto_pause", daemon, source_id: sourceId, by: "auto", failures });
  return paused;
}

/** Remember the window just queued and the failure streak behind it. */
export async function recordWindow(engine: Engine, daemon: string, sourceId: string, window: string, failures: number): Promise<void> {
  await engine.query(
    `INSERT INTO daemon_controls (daemon, source_id, last_window, consecutive_failures, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (daemon, source_id) DO UPDATE
       SET last_window = $3, consecutive_failures = $4, updated_at = NOW()`,
    [daemon, sourceId, window, failures],
  );
}

/** Status of a run of a daemon that keeps its own loop. */
export async function recordRun(engine: Engine, daemon: string, ok: boolean, outcome: string): Promise<void> {
  await engine.query(
    `INSERT INTO daemon_controls (daemon, source_id, last_run_at, last_outcome, consecutive_failures, updated_at)
     VALUES ($1, '*', NOW(), $2, $3, NOW())
     ON CONFLICT (daemon, source_id) DO UPDATE
       SET last_run_at = NOW(), last_outcome = $2,
           consecutive_failures = CASE WHEN $4 THEN 0 ELSE daemon_controls.consecutive_failures + 1 END,
           updated_at = NOW()`,
    [daemon, outcome.slice(0, MAX_REASON_CHARS), ok ? 0 : 1, ok],
  );
}
