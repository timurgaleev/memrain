/**
 * Job worker — claims due jobs and dispatches them to handlers.
 *
 * Designed to run in-process (single timer; not multi-thread). For
 * scale-out we'd add a process-id column + heartbeat; the queue's atomic
 * claim already supports multiple workers against the same Postgres
 * because of `FOR UPDATE SKIP LOCKED`.
 *
 * Lifecycle:
 *   const worker = new Worker(queue);
 *   await worker.start();      // schedules a recurring poll
 *   ...
 *   await worker.stop();       // drains the in-flight job, hands it back
 *                              // if it outlasts the drain window, then exits
 */
import { type BatchScope, runInBatchScope } from "../llm/bedrock-errors.ts";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { runWithSpendClient, runWithSpendTags } from "../budget.ts";
import { getHandler } from "./handlers.ts";
import { kindDefaultTimeoutMs } from "./kind-defaults.ts";
import { haltOf, llmHaltEnabled, noteHalt } from "./llm-halt.ts";
import type { Queue } from "./queue.ts";
import { type JobRow, UnrecoverableJobError } from "./types.ts";
import type { Engine } from "../engine/interface.ts";
import {
  acquireWorkerLock,
  heartbeatWorkerLock,
  releaseWorkerLock,
  DEFAULT_WORKER_LOCK_ID,
} from "./worker-lock.ts";

/** Queue.claim's default lock seconds — mirrored so lock-vs-timeout math agrees. */
const DEFAULT_LOCK_SECONDS = 300;
/** Times a job may wait out an outage before it fails the ordinary way. At
 *  the 30-minute cooldown cap that is about a day of waiting. */
export const MAX_DEFERS = 48;
/** How long stop() lets a running job finish before handing it back. Kept
 *  under Docker's default 10 s stop timeout. */
export const DEFAULT_DRAIN_MS = 8000;
/** How long stop() waits for aborted jobs to hand their rows back. */
const HAND_BACK_WAIT_MS = 5000;

export interface WorkerOptions {
  /** Polling interval when idle. Default 1000 ms. */
  intervalMs?: number;
  /** Max concurrent in-flight jobs. Default 1 (single-thread). */
  concurrency?: number;
  /** Hook for log lines — defaults to console.log/console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Seconds the running claim is valid for. Renewed every third of it while
   *  the handler runs. Default 300. */
  lockSeconds?: number;
  /** Run handleStalled() at most this often (ms). Default 30 000. */
  stallSweepIntervalMs?: number;
  /**
   * Default hard wall-clock cap (ms) for a job's handler when the job row does
   * not set its own `timeoutMs`. A job exceeding it is dead-lettered and the
   * worker freed. A per-job `timeoutMs` always wins over this default; without
   * either, the kind's built-in cap applies (`kind-defaults.ts`), else none.
   */
  jobTimeoutMs?: number;
  /**
   * Engine for the single-active-worker lock. When provided, the worker
   * elects one active instance via the `worker_lock` row (migration 042) and
   * heartbeats it each tick; other instances idle until the holder's heartbeat
   * lapses. Omit (e.g. in unit tests) to disable the guard entirely.
   */
  engine?: Engine;
  /** Lock id for the single-worker guard. Default `memrain-jobs-worker`. */
  workerLockId?: string;
  /** Seconds before a missed heartbeat lets another worker steal. Default 60. */
  workerLockTtlSeconds?: number;
  /**
   * Only claim jobs of these kinds. Lets an auxiliary worker (e.g. the jobs
   * smoke self-test) coexist with the live worker without draining its queue.
   */
  kinds?: string[];
  /**
   * How long stop() waits for running jobs (ms). A job still running after it
   * is aborted and handed back to `pending` without spending its retry or
   * stall budget. Default 8000.
   */
  drainMs?: number;
}

export interface WorkerStats {
  picked: number;
  succeeded: number;
  failed: number;
  retried: number;
  /** Total rows requeued by the stall sweep. */
  stallsRequeued: number;
  /** Total rows terminal-failed by the stall sweep. */
  stallsTerminallyFailed: number;
  /** Jobs dead-lettered by the per-job wall-clock timeout. */
  timedOut: number;
  /**
   * Attempts whose final complete/fail was refused because a newer attempt
   * had re-claimed the row (or it was cancelled or removed meanwhile).
   */
  fenced: number;
  /** Attempts put back to wait out an LLM outage, no retry spent. */
  deferred: number;
}

export class Worker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private stopping = false;
  private stopped = true;
  private lastStallSweep = 0;
  private holdsLock = false;
  private lockWarned = false;
  /** Running attempts, so stop() can abort the ones that outlast the drain. */
  private readonly running = new Map<string, AbortController>();
  private drainExpired = false;
  /** The tick in progress, so stop() can wait out a claim that is mid-flight. */
  private currentTick: Promise<void> | null = null;
  // Unique per Worker INSTANCE (not just per process): two Worker objects in
  // one process must be distinct holders, else both would re-acquire the same
  // lock (own-holder re-acquire always succeeds) and the guard would be moot.
  private readonly lockHolder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly stats: WorkerStats = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    stallsRequeued: 0,
    stallsTerminallyFailed: 0,
    timedOut: 0,
    fenced: 0,
    deferred: 0,
  };

  constructor(
    private readonly queue: Queue,
    private readonly opts: WorkerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.drainExpired = false;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + Math.max(0, this.opts.drainMs ?? DEFAULT_DRAIN_MS);
    // A tick awaiting claim() would otherwise start its job after we return.
    // Bounded by the drain window: a claim stuck on a dead database must not
    // eat the whole stop grace period.
    if (this.currentTick) {
      await Promise.race([this.currentTick, sleep(Math.max(0, deadline - Date.now()))]);
    }
    while (this.inflight > 0 && Date.now() < deadline) {
      await sleep(25);
    }
    if (this.inflight > 0) {
      // Past the drain window: abort what is still running. Each aborted
      // attempt hands its row back to `pending` and settles, so this second
      // wait is one UPDATE long, not one job long.
      this.drainExpired = true;
      this.log("warn", `drain window passed; handing back ${this.running.size} running job(s)`);
      for (const ctl of this.running.values()) ctl.abort(new WorkerShutdownError());
      // Bounded so a stuck hand-back UPDATE cannot outlast stop_grace_period;
      // a row left `running` is recovered by the stall sweep.
      const handBackDeadline = Date.now() + HAND_BACK_WAIT_MS;
      while (this.inflight > 0 && Date.now() < handBackDeadline) {
        await sleep(25);
      }
      if (this.inflight > 0) {
        this.log("warn", `${this.inflight} job(s) did not hand back in time; the stall sweep will recover them`);
      }
    }
    // Release the single-worker lock so a replacement can take over at once
    // (rather than waiting for the TTL to lapse).
    if (this.holdsLock && this.opts.engine) {
      try {
        await releaseWorkerLock(
          this.opts.engine,
          this.opts.workerLockId ?? DEFAULT_WORKER_LOCK_ID,
          this.lockHolder,
        );
      } catch (e) {
        this.log("error", `worker lock release failed: ${asMessage(e)}`);
      }
      this.holdsLock = false;
    }
    this.stopped = true;
  }

  /** Returns the running tally — useful for tests + the inspect CLI. */
  getStats(): Readonly<WorkerStats> {
    return { ...this.stats };
  }

  /**
   * Drain the queue once: claim and run jobs until `claim()` returns
   * null. Runs serially regardless of `concurrency`, so it's safe to
   * use from tests for deterministic ordering.
   */
  async drainOnce(): Promise<number> {
    let processed = 0;
    while (!this.stopping) {
      const job = await this.queue.claim(this.claimOpts());
      if (!job) break;
      await this.runJob(job);
      processed++;
    }
    return processed;
  }

  private claimOpts(): Parameters<Queue["claim"]>[0] {
    const claimOpts: Parameters<Queue["claim"]>[0] = {};
    if (this.opts.lockSeconds !== undefined) {
      claimOpts.lockSeconds = this.opts.lockSeconds;
    }
    if (this.opts.kinds !== undefined) {
      claimOpts.kinds = this.opts.kinds;
    }
    return claimOpts;
  }

  /** Run one stall sweep. Public so tests can advance it deterministically. */
  async sweepStalls(now: Date = new Date()): Promise<void> {
    const r = await this.queue.handleStalled({ now });
    this.stats.stallsRequeued += r.requeued;
    this.stats.stallsTerminallyFailed += r.terminallyFailed;
    this.lastStallSweep = now.getTime();
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    const interval = this.opts.intervalMs ?? 1000;
    this.timer = setTimeout(
      () => {
        this.currentTick = this.tick().finally(() => {
          this.currentTick = null;
        });
      },
      Math.max(0, delayMs ?? interval),
    );
  }

  /**
   * Single-active-worker gate. Returns true when this worker may do work this
   * tick. No engine configured → always true (guard disabled). Otherwise
   * acquire-or-heartbeat the lock; a worker that can't acquire (another live
   * holder) or that lost its lock idles this tick and retries next.
   */
  private async ensureWorkerLock(): Promise<boolean> {
    const engine = this.opts.engine;
    if (!engine) return true;
    const id = this.opts.workerLockId ?? DEFAULT_WORKER_LOCK_ID;
    const ttl = this.opts.workerLockTtlSeconds ?? 60;
    if (this.holdsLock) {
      const kept = await heartbeatWorkerLock(engine, id, this.lockHolder);
      if (!kept) {
        this.holdsLock = false;
        this.log("warn", "lost worker lock (heartbeat stolen) — idling");
        return false;
      }
      return true;
    }
    this.holdsLock = await acquireWorkerLock(engine, id, this.lockHolder, ttl);
    if (this.holdsLock) {
      this.log("info", `acquired worker lock as ${this.lockHolder}`);
      this.lockWarned = false;
    } else if (!this.lockWarned) {
      this.log("info", "another worker holds the lock — idling");
      this.lockWarned = true;
    }
    return this.holdsLock;
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const concurrency = Math.max(1, this.opts.concurrency ?? 1);
    try {
      // Single-active-worker gate: idle this tick if another worker holds the
      // lock. The `finally` still reschedules, so we retry next interval.
      if (!(await this.ensureWorkerLock())) return;
      // Stall sweep first — recovers rows whose worker died last tick
      // before they get blocked behind fresh claims.
      const sweepInterval = this.opts.stallSweepIntervalMs ?? 30_000;
      const nowMs = Date.now();
      if (nowMs - this.lastStallSweep >= sweepInterval) {
        try {
          await this.sweepStalls(new Date(nowMs));
        } catch (e) {
          this.log("error", `stall sweep crashed: ${asMessage(e)}`);
        }
      }
      while (this.inflight < concurrency && !this.stopping) {
        const job = await this.queue.claim(this.claimOpts());
        if (!job) break;
        this.inflight++;
        // Fire-and-forget; runJob updates inflight on completion. runJob never
        // throws (it guards its own bookkeeping), but keep a catch as a final
        // backstop so a stray rejection can never become an unhandledRejection.
        void this.runJob(job)
          .catch((e) => this.log("error", `[${job.id}] runJob: ${asMessage(e)}`))
          .finally(() => {
            this.inflight--;
          })
          // Terminal backstop: even the catch's logger or finally must never
          // surface as an unhandledRejection.
          .catch(() => {});
      }
    } catch (e) {
      this.log("error", `claim loop crashed: ${asMessage(e)}`);
    } finally {
      // If we picked something, retry quickly (more might be due);
      // otherwise wait the full interval.
      const idle = this.inflight === 0;
      this.scheduleNext(idle ? (this.opts.intervalMs ?? 1000) : 50);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    this.stats.picked++;
    // The claim token for this attempt: every write below presents it, so once
    // a newer attempt re-claims the row, this one's writes change nothing.
    const gen = job.claimGeneration;
    const handler = getHandler(job.kind);
    if (!handler) {
      const msg = `no handler registered for kind '${job.kind}'`;
      this.log("error", `[${job.id}] ${msg}`);
      try {
        // A process that cannot run the kind will not learn to by retrying.
        const updated = await this.queue.fail(job.id, gen, msg, { terminal: true });
        if (!updated && (await this.claimLost(job.id, gen))) return;
        this.stats.failed++;
      } catch (e) {
        this.log("error", `[${job.id}] no-handler fail persist: ${asMessage(e)}`);
      }
      return;
    }
    // Per-job hard wall-clock cap: the job row, then the worker default, then
    // the kind's built-in cap.
    const timeoutMs =
      job.timeoutMs ?? this.opts.jobTimeoutMs ?? kindDefaultTimeoutMs(job.kind) ?? 0;
    // Aborted when the attempt is abandoned: drain expired, timeout, or lease
    // lost. The reason is the error the attempt settles with.
    const abort = new AbortController();
    if (this.drainExpired) abort.abort(new WorkerShutdownError());
    // Handler context: progress + token/cost usage persist onto the job row
    // while it runs (fenced by `gen`, so a lost claim makes them no-ops).
    const ctx = {
      job,
      updateProgress: (progress: Record<string, unknown>) =>
        this.queue.updateProgress(job.id, gen, progress),
      recordUsage: (usage: Parameters<Queue["recordUsage"]>[2]) =>
        this.queue.recordUsage(job.id, gen, usage),
      signal: abort.signal,
    };
    this.running.set(job.id, abort);
    const lease = this.renewLease(job, gen, abort);
    // The whole body is guarded: a persistence failure (complete/fail) must
    // never crash the worker tick or escape as an unhandledRejection.
    try {
      try {
        // An abandoned handler keeps running; the scope flag stops its paid
        // calls. The circuit lets an LLM outage fail the rest of the job fast;
        // the job then waits the outage out instead of spending its retries.
        const scope: BatchScope = { stopped: false, circuit: llmHaltEnabled() };
        abort.signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = abort.signal.reason;
            if (reason instanceof WorkerShutdownError) scope.stopReason = "worker_shutdown";
            else if (reason instanceof ClaimLostError) scope.stopReason = "claim_lost";
            scope.stopped = true;
          },
          { once: true },
        );
        // Paid calls book against this job, and against the client that
        // submitted it, so a tenant's queued work counts toward its own cap.
        const submittedBy = job.submittedBy;
        const inScope = () => runInBatchScope(scope, () => handler(job.payload, ctx));
        const run = () =>
          runWithSpendTags({ jobId: job.id }, () =>
            submittedBy ? runWithSpendClient({ clientId: submittedBy }, inScope) : inScope(),
          );
        let result: Record<string, unknown> | void;
        try {
          result = await runUntilAborted(
            timeoutMs > 0 ? runWithTimeout(run, timeoutMs) : startRun(run),
            abort.signal,
          );
        } catch (e) {
          scope.stopped = true;
          // The timed-out handler is abandoned: stop its in-flight calls.
          if (e instanceof JobTimeoutError && !abort.signal.aborted) abort.abort(e);
          throw e;
        } finally {
          lease.stop();
        }
        const done = await this.queue.complete(
          job.id,
          gen,
          result === undefined ? {} : result,
        );
        if (done || !(await this.claimLost(job.id, gen))) {
          this.stats.succeeded++;
        }
      } catch (e) {
        if (e instanceof WorkerShutdownError) {
          // Not a failure: the worker is leaving. Hand the row back so the
          // next worker picks it up at once, budgets untouched.
          const released = await this.queue.releaseForShutdown(job.id, gen);
          this.log(
            "warn",
            `[${job.id}] ${job.kind} ${released ? "handed back on shutdown" : "shutdown hand-back refused (claim no longer held)"}`,
          );
          return;
        }
        if (e instanceof ClaimLostError) {
          // The row is no longer this attempt's (cancelled, or requeued and
          // re-claimed): whatever it would write belongs to someone else.
          this.stats.fenced++;
          this.log("warn", `[${job.id}] ${job.kind} ${e.message} (gen ${gen}); attempt abandoned, nothing written`);
          return;
        }
        const message = asMessage(e);
        // A hard timeout dead-letters (terminal): the handler is abandoned and
        // retrying would only wedge the worker again. So does a failure the
        // handler marked unrecoverable.
        const timedOut = e instanceof JobTimeoutError;
        const unrecoverable = !timedOut && isUnrecoverable(e);
        if (!timedOut && !unrecoverable && (await this.deferForOutage(job, gen, e, message))) {
          return;
        }
        this.log(
          "warn",
          `[${job.id}] ${job.kind} ${timedOut ? "timed out" : unrecoverable ? "failed (unrecoverable)" : "failed"}: ${message}`,
        );
        const updated = await this.queue.fail(
          job.id,
          gen,
          unrecoverable ? `unrecoverable: ${message}` : message,
          timedOut || unrecoverable ? { terminal: true } : {},
        );
        if (timedOut) this.stats.timedOut++;
        if (!updated && (await this.claimLost(job.id, gen))) return;
        if (updated && updated.status === "pending") {
          this.stats.retried++;
        } else {
          this.stats.failed++;
        }
      }
    } catch (e) {
      this.log("error", `[${job.id}] job bookkeeping failed: ${asMessage(e)}`);
    } finally {
      lease.stop();
      this.running.delete(job.id);
    }
  }

  /**
   * Keep this attempt's claim alive while its handler runs: every third of the
   * lock, push `lock_until` out by a full lock. A refused renewal means the row
   * is no longer this attempt's — cancelled, or requeued and re-claimed — so
   * the attempt is aborted. A renewal that errors is logged and retried; once
   * the lease would lapse before the next try, the attempt aborts too, since
   * the stall sweep may hand the row to another worker after that.
   */
  private renewLease(job: JobRow, gen: number, abort: AbortController): { stop(): void } {
    const lockMs = (this.opts.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1000;
    const everyMs = Math.max(10, Math.floor(lockMs / 3));
    let heldUntil = job.lockUntil?.getTime() ?? Date.now() + lockMs;
    let renewing = false;
    let stopped = false;
    const lose = (why: string) => {
      if (stopped || abort.signal.aborted) return;
      this.log("warn", `[${job.id}] ${why}`);
      abort.abort(new ClaimLostError(why));
    };
    const timer = setInterval(() => {
      if (renewing || stopped) return;
      renewing = true;
      const until = Date.now() + lockMs;
      this.queue
        .extendLock(job.id, gen, new Date(until))
        .then((held) => {
          if (held) heldUntil = until;
          else lose("lost its claim");
        })
        .catch((e: unknown) => {
          this.log("error", `[${job.id}] lease renewal failed: ${asMessage(e)}`);
          if (Date.now() + everyMs >= heldUntil) lose("lease could not be renewed before it lapsed");
        })
        .finally(() => {
          renewing = false;
        });
    }, everyMs);
    timer.unref?.();
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Put the attempt back to wait out an LLM outage, without spending a retry.
   * True when the row needs nothing more from this attempt (deferred, or no
   * longer this attempt's). A job past MAX_DEFERS fails the ordinary way.
   */
  private async deferForOutage(
    job: JobRow,
    gen: number,
    err: unknown,
    message: string,
  ): Promise<boolean> {
    if (!llmHaltEnabled()) return false;
    const halt = haltOf(err);
    if (!halt) return false;
    if (job.deferredCount >= MAX_DEFERS) {
      this.log("warn", `[${job.id}] ${job.kind} waited out ${job.deferredCount} outages; failing it`);
      return false;
    }
    const until = noteHalt(halt.key, halt.cls);
    const deferred = await this.queue.defer(
      job.id,
      gen,
      new Date(until),
      `${halt.cls}: ${message.slice(0, 300)}`,
    );
    if (!deferred) return this.claimLost(job.id, gen);
    this.stats.deferred++;
    this.log(
      "warn",
      `[${job.id}] ${job.kind} deferred until ${new Date(until).toISOString()} ` +
        `(${halt.cls} on ${halt.key === "*" ? "every model" : halt.key}); no retry spent`,
    );
    return true;
  }

  /**
   * After a refused terminal write: true (and counted as fenced) when a newer
   * attempt has re-claimed the row. A row that was cancelled or removed under
   * the same claim returns false and keeps the old accounting.
   */
  private async claimLost(id: string, gen: number): Promise<boolean> {
    const row = await this.queue.get(id);
    if (!row || row.claimGeneration === gen) return false;
    this.stats.fenced++;
    this.log(
      "warn",
      `[${id}] claim lost to a newer attempt (gen ${gen}); result discarded`,
    );
    return true;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    const fn = this.opts.logger;
    if (fn) {
      fn(level, msg);
      return;
    }
    if (level === "error" || level === "warn") {
      console.error(`[jobs] ${msg}`);
    } else {
      console.log(`[jobs] ${msg}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Thrown when a job handler exceeds its hard wall-clock cap. */
export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`job exceeded its ${ms}ms timeout`);
    this.name = "JobTimeoutError";
  }
}

/** Thrown into a running job when stop()'s drain window has passed. */
export class WorkerShutdownError extends Error {
  constructor() {
    super("worker_shutdown");
    this.name = "WorkerShutdownError";
  }
}

/** Thrown into a running job whose lease renewal found the claim gone. */
export class ClaimLostError extends Error {
  constructor(why = "lost its claim") {
    super(why);
    this.name = "ClaimLostError";
  }
}

function isUnrecoverable(e: unknown): boolean {
  return e instanceof UnrecoverableJobError || (e instanceof Error && e.name === "UnrecoverableJobError");
}

/** Call `start()`, turning a synchronous throw into a rejection. */
function startRun<T>(start: () => Promise<T>): Promise<T> {
  try {
    return start();
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Settle with `work`, or reject with the abort reason (`WorkerShutdownError`
 * when it is not an error) once `signal` aborts. Like a timeout, the abandoned
 * work keeps running; its late settlement is swallowed.
 */
function runUntilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new WorkerShutdownError();
  if (signal.aborted) return Promise.reject(reason());
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Run `start()`'s promise under a hard wall-clock cap. On timeout the returned
 * promise rejects with `JobTimeoutError` and the worker moves on; the orphaned
 * handler keeps running (JS has no cancellation) but its late settlement is
 * swallowed so it never surfaces as an unhandledRejection. The timer is cleared
 * on the normal path so it can't keep the event loop alive.
 *
 * NOTE the orphan can still mutate NON-queue state (documents, chunks, ...)
 * after the dead-letter — the queue row is protected by claim-generation
 * write fences, but a handler with external side effects must be idempotent.
 */
function runWithTimeout<T>(start: () => Promise<T>, ms: number): Promise<T> {
  let work: Promise<T>;
  try {
    work = start();
  } catch (e) {
    // A handler that throws synchronously (before returning a promise) becomes
    // a normal rejection so runJob's catch routes it through fail(). A thrown
    // non-Error is wrapped; `asMessage` already rendered it with String(), so
    // the dead-letter message is unchanged, and a real Error (JobTimeoutError
    // included) passes through untouched so the `instanceof` check still holds.
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  // Guard: if `work` loses the race and later rejects, swallow it here.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
