/**
 * In-process daemon scheduler. Off unless MEMRAIN_DAEMONS=1.
 *
 * Every tick (60 s) the process that holds the `memrain-daemons` row lock — a
 * plain table row with a TTL, so it survives a transaction pooler — walks the
 * registry and queues each due daemon into the existing job queue under the
 * id `daemon:<name>:<source>:<window>`. The leader lock keeps a second process
 * idle; the stable id is what makes a race between two leaders (a deploy
 * overlap, a stolen lock) harmless, since the second insert of a window finds
 * the first and queues nothing.
 *
 * Only the latest window is ever queued, and only while it is younger than
 * the catch-up age (6 h): a brain that was down for days runs each daemon
 * once, not once per missed window. The scheduler spends nothing itself.
 */
import type { Engine } from "../engine/interface.ts";
import { brainDailyCapUsd } from "../budget.ts";
import { tryAcquireDbLock, type DbLockHandle } from "../db-lock.ts";
import { getHandler, registerHandler } from "../jobs/handlers.ts";
import { Queue } from "../jobs/queue.ts";
import type { JobHandler } from "../jobs/types.ts";
import {
  AUTO_PAUSE_AFTER_FAILURES,
  autoPause,
  envSwitches,
  readControls,
  readControlsFor,
  recordWindow,
  resolveControl,
} from "./controls.ts";
import { CronError, assertTimeZone, parseCron, previousFire, windowKey } from "./cron.ts";
import { DEFAULT_DAEMON_SOURCE, listDaemons, type DaemonSpec, type DaemonTarget } from "./registry.ts";

export const DAEMON_LOCK_ID = "memrain-daemons";
const LOCK_TTL_MINUTES = 5;
const DEFAULT_TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
const DEFAULT_CATCHUP_MAX_AGE_MS = 6 * 3_600_000;
const DEFAULT_MAX_RETRIES = 2;

export type DaemonOutcome =
  | "queued"
  | "already_queued"
  | "paused"
  | "auto_paused"
  | "disabled"
  | "env_disabled"
  | "no_handler"
  | "no_brain_cap"
  | "bad_schedule"
  | "targets_failed"
  | "no_window"
  | "window_too_old";

export interface DaemonTickResult {
  daemon: string;
  sourceId: string | null;
  outcome: DaemonOutcome;
  window?: string;
  jobId?: string;
  detail?: string;
}

type Log = (level: "info" | "warn" | "error", msg: string) => void;

export interface DueOptions {
  env?: NodeJS.ProcessEnv;
  log?: Log;
}

const defaultLog: Log = (level, msg) => (level === "info" ? console.log : console.error)(`[daemons] ${msg}`);

function catchupMaxAgeMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MEMRAIN_DAEMON_CATCHUP_MAX_AGE_S?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : DEFAULT_CATCHUP_MAX_AGE_MS;
}

/** The job-id prefix shared by every run of a daemon for one source. */
export function daemonJobPrefix(daemon: string, sourceId: string): string {
  return `daemon:${daemon}:${sourceId}:`;
}

/**
 * Failed runs in a row, newest first, among finished runs since `since`.
 * A run is a job row: its retries are one run, and a run deferred by an
 * outage is still pending, so neither inflates the count.
 */
export async function consecutiveFailures(engine: Engine, spec: DaemonSpec, sourceId: string, since: string | null): Promise<number> {
  const r = await engine.query<{ status: string }>(
    `SELECT status FROM jobs
      WHERE kind = $4 AND starts_with(id, $1) AND status IN ('succeeded', 'failed') AND created_at > $2
      ORDER BY created_at DESC LIMIT $3`,
    [daemonJobPrefix(spec.name, sourceId), since ?? new Date(0).toISOString(), AUTO_PAUSE_AFTER_FAILURES, spec.kind],
  );
  let n = 0;
  for (const row of r.rows) {
    if (row.status !== "failed") break;
    n++;
  }
  return n;
}

async function targetsOf(engine: Engine, spec: DaemonSpec): Promise<DaemonTarget[]> {
  return spec.targets ? spec.targets(engine) : [{ sourceId: DEFAULT_DAEMON_SOURCE }];
}

/** Queue every daemon whose latest window is due and not yet queued. */
export async function enqueueDueDaemons(engine: Engine, now: Date, opts: DueOptions = {}): Promise<DaemonTickResult[]> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  const switches = envSwitches(env);
  if (!switches.on) return [];
  const maxAge = catchupMaxAgeMs(env);
  const queue = new Queue(engine);
  const rows = await readControls(engine);
  const results: DaemonTickResult[] = [];
  for (const spec of listDaemons()) {
    if (spec.schedule === "external") continue;
    const skip = (outcome: DaemonOutcome, detail?: string) =>
      results.push({ daemon: spec.name, sourceId: null, outcome, ...(detail ? { detail } : {}) });
    if (switches.disabled.has(spec.name)) { skip("env_disabled"); continue; }
    if (!getHandler(spec.kind)) { skip("no_handler"); continue; }
    if (spec.paid && brainDailyCapUsd(env) === null) { skip("no_brain_cap"); continue; }
    let targets: DaemonTarget[];
    try {
      targets = await targetsOf(engine, spec);
    } catch (e) {
      skip("targets_failed", e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const t of targets) {
      results.push(await enqueueTarget(engine, queue, spec, t, rows, now, maxAge, log));
    }
  }
  return results;
}

async function enqueueTarget(
  engine: Engine,
  queue: Queue,
  spec: DaemonSpec,
  t: DaemonTarget,
  rows: Awaited<ReturnType<typeof readControls>>,
  now: Date,
  maxAgeMs: number,
  log: Log,
): Promise<DaemonTickResult> {
  const base = { daemon: spec.name, sourceId: t.sourceId };
  const ctl = resolveControl(rows, spec.name, t.sourceId);
  if (ctl.pausedBy) return { ...base, outcome: "paused" };
  if (!(ctl.enabled ?? spec.defaultEnabled)) return { ...base, outcome: "disabled" };
  const failures = await consecutiveFailures(engine, spec, t.sourceId, ctl.resumedAt);
  if (failures >= AUTO_PAUSE_AFTER_FAILURES) {
    if (await autoPause(engine, spec.name, t.sourceId, failures)) {
      log("warn", `${spec.name} (${t.sourceId}) auto-paused after ${failures} failed runs in a row; resume with \`memrain daemons resume ${spec.name}\``);
    }
    return { ...base, outcome: "auto_paused" };
  }
  const schedule = spec.schedule as { cron: string; timezone?: string };
  const tz = ctl.timezone ?? schedule.timezone ?? "UTC";
  let fire;
  try {
    fire = previousFire(parseCron(ctl.cron ?? schedule.cron), now, assertTimeZone(tz));
  } catch (e) {
    if (!(e instanceof CronError)) throw e;
    return { ...base, outcome: "bad_schedule", detail: e.message };
  }
  if (!fire) return { ...base, outcome: "no_window" };
  const window = windowKey(fire, tz);
  if (now.getTime() - fire.at.getTime() > maxAgeMs) return { ...base, outcome: "window_too_old", window };
  if (ctl.lastWindow === window) return { ...base, outcome: "already_queued", window };
  const id = `${daemonJobPrefix(spec.name, t.sourceId)}${window}`;
  const { created } = await queue.enqueueIfAbsent({
    id,
    kind: spec.kind,
    payload: { daemon: spec.name, sourceId: t.sourceId, window },
    maxRetries: spec.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.quietHoursSkip ? { quietHoursSkip: true } : {}),
    ...(t.submittedBy !== undefined && t.authority !== undefined ? { submittedBy: t.submittedBy, authority: t.authority } : {}),
  });
  await recordWindow(engine, spec.name, t.sourceId, window, failures);
  return { ...base, outcome: created ? "queued" : "already_queued", window, jobId: id };
}

/**
 * Register the job handler of a scheduled daemon. A run queued before a pause
 * or a kill switch is checked again when the worker claims it, and skipped:
 * the job succeeds with `{ skipped }` and the handler never runs. A run that
 * has already started finishes, or stops at its own checkpoints.
 */
export function registerDaemonHandler(
  engine: Engine,
  spec: DaemonSpec,
  handler: JobHandler,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  registerHandler(spec.kind, async (payload, ctx) => {
    const switches = envSwitches(opts.env ?? process.env);
    if (!switches.on || switches.disabled.has(spec.name)) return { skipped: "disabled" };
    const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : DEFAULT_DAEMON_SOURCE;
    const ctl = resolveControl(await readControlsFor(engine, spec.name, sourceId), spec.name, sourceId);
    if (ctl.pausedBy) return { skipped: "paused" };
    if (!(ctl.enabled ?? spec.defaultEnabled)) return { skipped: "disabled" };
    return handler(payload, ctx);
  });
}

export type TickReport =
  | { status: "disabled" }
  | { status: "not_leader" }
  | { status: "ran"; results: DaemonTickResult[] };

export interface DaemonHealth {
  leader: boolean;
  /** Seconds since this process last ticked; null before the first tick. */
  tick_age_s: number | null;
}

export interface SchedulerOptions extends DueOptions {
  tickMs?: number;
}

export class DaemonScheduler {
  private lock: DbLockHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private lastTickAt: number | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly engine: Engine, private readonly opts: SchedulerOptions = {}) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(FIRST_TICK_MS);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tickOnce()
        .catch(e => (this.opts.log ?? defaultLog)("error", `tick failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          this.running = null;
          this.schedule(this.opts.tickMs ?? DEFAULT_TICK_MS);
        });
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One tick: kill switch, leadership, then queue what is due. */
  async tickOnce(now: Date = new Date()): Promise<TickReport> {
    if (!envSwitches(this.opts.env ?? process.env).on) {
      await this.dropLeadership();
      return { status: "disabled" };
    }
    if (this.lock && !(await this.lock.refresh())) await this.dropLeadership();
    if (!this.lock) this.lock = await tryAcquireDbLock(this.engine, DAEMON_LOCK_ID, LOCK_TTL_MINUTES);
    this.lastTickAt = Date.now();
    if (!this.lock) return { status: "not_leader" };
    return { status: "ran", results: await enqueueDueDaemons(this.engine, now, this.opts) };
  }

  private async dropLeadership(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release();
  }

  health(): DaemonHealth {
    return {
      leader: this.lock !== null,
      tick_age_s: this.lastTickAt === null ? null : Math.floor((Date.now() - this.lastTickAt) / 1000),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    await this.dropLeadership();
  }
}

let active: DaemonScheduler | null = null;

/** Start the process's scheduler (serve calls this when MEMRAIN_DAEMONS=1). */
export function startDaemonScheduler(engine: Engine, opts: SchedulerOptions = {}): DaemonScheduler {
  const s = new DaemonScheduler(engine, opts);
  s.start();
  active = s;
  return s;
}

/** Stop the process's scheduler and release its leadership. */
export async function stopDaemonScheduler(): Promise<void> {
  const s = active;
  active = null;
  await s?.stop();
}

/** For /health: this process's scheduler, or null when none runs here. */
export function daemonSchedulerHealth(): DaemonHealth | null {
  return active?.health() ?? null;
}
