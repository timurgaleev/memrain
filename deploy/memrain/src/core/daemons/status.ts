/**
 * The operator's view of the daemons (CLI `memrain daemons`, MCP
 * `daemons_status` / `daemons_control`): what is registered, what is paused
 * and by whom, which process leads the scheduler and how fresh its tick is.
 */
import type { Engine } from "../engine/interface.ts";
import { inspectLock, isLockHolderLive } from "../db-lock.ts";
import { OperationError } from "../operation-error.ts";
import {
  ALL,
  envSwitches,
  pauseDaemon,
  readControls,
  resolveControl,
  resumeDaemon,
  type DaemonControlRow,
} from "./controls.ts";
import { CronError, nextFire, parseCron, windowKey } from "./cron.ts";
import { getDaemon, listDaemons, type DaemonSpec } from "./registry.ts";
import { DAEMON_LOCK_ID } from "./scheduler.ts";

export interface PauseInfo {
  by: string | null;
  reason: string | null;
  at: string | null;
}

export interface DaemonSourceStatus {
  source_id: string;
  paused: PauseInfo | null;
  last_window: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  consecutive_failures: number;
}

export interface DaemonStatus {
  name: string;
  kind: string;
  schedule: string;
  lane: string;
  paid: boolean;
  enabled: boolean;
  env_disabled: boolean;
  paused: PauseInfo | null;
  next_window: string | null;
  last_window: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  consecutive_failures: number;
  sources: DaemonSourceStatus[];
}

export interface DaemonsReport {
  scheduler: {
    /** MEMRAIN_DAEMONS=1 in the process answering. */
    enabled_here: boolean;
    leader: { holder: string; tick_age_s: number | null; live: boolean } | null;
  };
  paused_all: PauseInfo | null;
  daemons: DaemonStatus[];
}

const pauseOf = (r: DaemonControlRow | undefined | null): PauseInfo | null =>
  r?.paused ? { by: r.paused_by, reason: r.paused_reason, at: r.paused_at } : null;

function scheduleOf(spec: DaemonSpec, row: DaemonControlRow | undefined): string {
  if (spec.schedule === "external") return "external";
  return `${row?.cron ?? spec.schedule.cron} @ ${row?.timezone ?? spec.schedule.timezone ?? "UTC"}`;
}

function nextWindow(spec: DaemonSpec, row: DaemonControlRow | undefined, now: Date): string | null {
  if (spec.schedule === "external") return null;
  const tz = row?.timezone ?? spec.schedule.timezone ?? "UTC";
  try {
    const f = nextFire(parseCron(row?.cron ?? spec.schedule.cron), now, tz);
    return f ? windowKey(f, tz) : null;
  } catch (e) {
    if (e instanceof CronError) return null;
    throw e;
  }
}

export async function daemonsStatus(engine: Engine, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<DaemonsReport> {
  const rows = await readControls(engine);
  const switches = envSwitches(env);
  const lock = await inspectLock(engine, DAEMON_LOCK_ID);
  const daemons = listDaemons().map((spec): DaemonStatus => {
    const wide = rows.find(r => r.daemon === spec.name && r.source_id === ALL);
    const ctl = resolveControl(rows, spec.name, ALL);
    return {
      name: spec.name,
      kind: spec.kind,
      schedule: scheduleOf(spec, wide),
      lane: spec.lane,
      paid: spec.paid,
      enabled: ctl.enabled ?? spec.defaultEnabled,
      env_disabled: switches.disabled.has(spec.name),
      paused: pauseOf(wide),
      next_window: nextWindow(spec, wide, now),
      last_window: wide?.last_window ?? null,
      last_run_at: wide?.last_run_at ?? null,
      last_outcome: wide?.last_outcome ?? null,
      consecutive_failures: wide?.consecutive_failures ?? 0,
      sources: rows.filter(r => r.daemon === spec.name && r.source_id !== ALL).map(r => ({
        source_id: r.source_id,
        paused: pauseOf(r),
        last_window: r.last_window,
        last_run_at: r.last_run_at,
        last_outcome: r.last_outcome,
        consecutive_failures: r.consecutive_failures,
      })),
    };
  });
  return {
    scheduler: {
      enabled_here: switches.on,
      leader: lock
        ? {
            holder: `${lock.holder_host}:${lock.holder_pid}`,
            tick_age_s: lock.ms_since_last_refresh === null ? null : Math.floor(lock.ms_since_last_refresh / 1000),
            live: isLockHolderLive(lock, 5),
          }
        : null,
    },
    paused_all: pauseOf(rows.find(r => r.daemon === ALL && r.source_id === ALL)),
    daemons,
  };
}

const SOURCE_RE = /^[A-Z0-9][\w.-]{0,63}$/i;
const MAX_REASON = 200;

export interface ControlArgs {
  action?: unknown;
  daemon?: unknown;
  source_id?: unknown;
  reason?: unknown;
}

/** Pause or resume. `all` (or `*`) as the daemon means every daemon. */
export async function controlDaemon(engine: Engine, args: ControlArgs, by: string): Promise<{ ok: true; action: string; daemon: string; source_id: string }> {
  const action = args.action;
  if (action !== "pause" && action !== "resume") {
    throw new OperationError("invalid_params", "daemons_control: `action` must be pause or resume", "Pass action: \"pause\" or \"resume\".");
  }
  const raw = typeof args.daemon === "string" ? args.daemon.trim() : "";
  const daemon = raw === "all" ? ALL : raw;
  if (daemon !== ALL && !getDaemon(daemon)) {
    throw new OperationError(
      "invalid_params",
      `daemons_control: unknown daemon '${raw}'`,
      `Pass one of: all, ${listDaemons().map(d => d.name).join(", ")}.`,
    );
  }
  let sourceId: string | undefined;
  if (args.source_id !== undefined && args.source_id !== null) {
    if (typeof args.source_id !== "string" || !SOURCE_RE.test(args.source_id) || daemon === ALL) {
      throw new OperationError("invalid_params", "daemons_control: `source_id` must be a source id, and only with a named daemon", "Pass a source id such as `default`, or omit it.");
    }
    sourceId = args.source_id;
  }
  if (args.reason !== undefined && typeof args.reason !== "string") {
    throw new OperationError("invalid_params", "daemons_control: `reason` must be a string", "Pass a short reason, or omit it.");
  }
  const target = { daemon, by, ...(sourceId ? { sourceId } : {}) };
  if (action === "pause") {
    await pauseDaemon(engine, { ...target, ...(typeof args.reason === "string" ? { reason: args.reason.slice(0, MAX_REASON) } : {}) });
  } else {
    await resumeDaemon(engine, target);
  }
  return { ok: true, action, daemon: daemon === ALL ? "all" : daemon, source_id: sourceId ?? ALL };
}
