/**
 * Cycle loop recipe — replaces the old dream.ts.
 *
 * Periodically runs `core/cycle/runCycleOnce()` (the maintenance phase
 * pipeline). Honours quiet hours so it doesn't fight interactive MCP
 * recall traffic for CPU. Skips embed-stale during quiet hours but still
 * runs the cheap read-only phases (reconcile-links, snapshot) — those are
 * useful state even during a quiet-hours window.
 */
import type { Storage } from "../core/storage.ts";
import {
  ALL_PHASES,
  SYNTHESIS_PHASES,
  runCycleOnce,
  runInAbortableBatchScope,
  type CycleOptions,
  type PhaseName,
} from "../core/cycle/index.ts";
import { consoleProgress } from "../core/output/progress.ts";
import { phasesRunTodayUtc } from "../core/cycle/phase-runs.ts";
import { runDeepSynthPhase } from "../core/synthesis/deep-synth.ts";
import {
  tryAcquireDbLock,
  reapDeadHolderLocks,
  CYCLE_LOCK_ID,
  startLockHeartbeat,
  type DbLockHandle,
} from "../core/db-lock.ts";

export interface CycleLoopOptions {
  /** Interval between ticks, ms. */
  intervalMs: number;
  /** Forwarded to embed-stale. Default 30. */
  staleDays?: number;
  /** Inclusive quiet-hour start in the configured zone (default 6). */
  quietStartHour?: number;
  /** Exclusive quiet-hour end in the configured zone (default 8). */
  quietEndHour?: number;
}

export interface CycleHandle {
  stop: () => Promise<void>;
}

const DEFAULT_QUIET_START = 6;
const DEFAULT_QUIET_END = 8;

// Cycle-lock TTL, minutes. 5 (not 30) so a crashed or cross-host holder's row
// TTL-expires within 5 min and the next tick's host-agnostic tryAcquireDbLock
// upsert reclaims it — instead of a dead container's lock blocking the cycle for
// the full 30 min. Healthy long runs stay alive via the sub-TTL refresher (every
// 30s).
const LOCK_TTL_MINUTES = 5;

// The first tick fires after THIS short delay (boot CPU headroom), not the full
// interval. A long `intervalMs` (e.g. the 6h prod default) deferred the first
// tick a full interval, and every container recreation (deploy / OOM restart)
// reset that timer — so a brain redeployed more often than its interval never
// completed a tick and its maintenance cycle starved (caught by the
// cycle-freshness doctor check: snapshots 53h stale despite a 6h interval).
// 60s gives boot headroom without coupling first-cycle latency to the interval.
// Tunable via MEMRAIN_CYCLE_FIRST_TICK_DELAY_MS for a tiny instance where 60s of
// boot contention (serve + jobs worker init) is still too eager.
const DEFAULT_INITIAL_TICK_DELAY_MS = 60_000;

function initialTickDelayMs(): number {
  const raw = process.env.MEMRAIN_CYCLE_FIRST_TICK_DELAY_MS;
  if (raw === undefined || raw === "") return DEFAULT_INITIAL_TICK_DELAY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INITIAL_TICK_DELAY_MS;
}

/**
 * Delay before the FIRST tick: short enough that a frequently-redeployed brain
 * still cycles, but never longer than the interval itself (a sub-minute test
 * interval keeps its own cadence).
 */
export function firstTickDelayMs(intervalMs: number): number {
  return Math.min(Math.max(0, intervalMs), initialTickDelayMs());
}

// Phases skipped during quiet hours. embed-stale and embed-gaps call Bedrock;
// mirror-pages re-embeds stale/missing page mirrors (also Bedrock); extract-timeline (when
// MEMRAIN_MEETING_TIMELINE=1) is a replace-own-projection that re-derives every
// meeting's events, so it is write-heavy on a meeting-rich vault.
const COSTLY_PHASES: ReadonlySet<PhaseName> = new Set([
  "embed-stale",
  "embed-gaps",
  "mirror-pages",
  "embed-facts",
  "extract-timeline",
]);

function isInQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
): boolean {
  const berlinHourStr = now.toLocaleString("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hour12: false,
  });
  const hour = Number(berlinHourStr);
  if (!Number.isFinite(hour)) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Delay before the NEXT tick. A skipped (lock-contended) tick retries within the
 * TTL window so a crashed cross-host holder doesn't stall the cycle a full
 * interval; a tick that ran re-arms at the normal interval.
 */
export function nextTickDelayMs(intervalMs: number, skipped: boolean): number {
  return skipped
    ? Math.min(intervalMs, LOCK_TTL_MINUTES * 60 * 1000)
    : intervalMs;
}

/** Parse the `MEMRAIN_CYCLE_SKIP_PHASES` CSV into a phase-name set. */
export function parseSkipPhases(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Positive-integer env override with a fallback (0/blank/garbage → fallback). */
export function capEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `MEMRAIN_SYNTHESIS_ONCE_PER_DAY`: on unless set to 0. */
export function synthesisOncePerDay(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMRAIN_SYNTHESIS_ONCE_PER_DAY !== "0";
}

/**
 * Build a tick's phase list. Quiet hours drop COSTLY_PHASES (embed-stale etc.)
 * AND are the only window where the opt-in synthesis chain runs (it's the
 * heaviest Haiku work, so keep it off peak). A synthesis phase named in
 * `ranTodayUtc` has already run this UTC day and is left out, so a short tick
 * interval does not multiply its bill. The operator skip-list applies last.
 */
export function selectTickPhases(opts: {
  inQuiet: boolean;
  synthEnabled: boolean;
  skipPhases: Set<string>;
  ranTodayUtc?: ReadonlySet<string>;
}): PhaseName[] {
  const base: PhaseName[] = opts.inQuiet
    ? ALL_PHASES.filter((p) => !COSTLY_PHASES.has(p))
    : [...ALL_PHASES];
  if (opts.synthEnabled && opts.inQuiet) {
    base.push(...SYNTHESIS_PHASES.filter((p) => !opts.ranTodayUtc?.has(p)));
  }
  return base.filter((p) => !opts.skipPhases.has(p));
}

/**
 * The paid deep-synth pass, bound to the cycle lock's heartbeat: a lock lost
 * mid-pass stops its Bedrock calls at once and ends it before the next question.
 */
export function runDeepSynthUnderLock(
  storage: Storage,
  signal: AbortSignal,
  run: typeof runDeepSynthPhase = runDeepSynthPhase,
): ReturnType<typeof runDeepSynthPhase> {
  return runInAbortableBatchScope(signal, () => run(storage, { signal }));
}

export function startCycleLoop(
  storage: Storage,
  options: CycleLoopOptions,
): CycleHandle {
  const quietStart = options.quietStartHour ?? DEFAULT_QUIET_START;
  const quietEnd = options.quietEndHour ?? DEFAULT_QUIET_END;
  const staleDays = options.staleDays ?? 30;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The lock held by an in-flight tick, tracked at loop scope so a graceful
  // stop() can release it deterministically — otherwise a SIGTERM landing
  // mid-tick (every deploy) would abandon the tick's `finally` and strand the
  // lock until the TTL lapses. `null` between ticks.
  let currentLock: DbLockHandle | null = null;

  // Operator escape hatch: drop named phases from every tick. Exists so a phase
  // with a live defect (e.g. a memory spike that SIGKILLs the tick before it can
  // snapshot) can be isolated WITHOUT losing the rest of the maintenance cycle,
  // while the defect is root-caused. CSV of PhaseName, e.g.
  // MEMRAIN_CYCLE_SKIP_PHASES=extract-timeline.
  const skipPhases = parseSkipPhases(process.env.MEMRAIN_CYCLE_SKIP_PHASES);

  // Opt-in (default-OFF) auto-think: appends the Haiku synthesis chain
  // (atoms→concepts→takes→grade→calibration, all writing the ISOLATED synth_*
  // store, never documents/pages) to QUIET-HOURS ticks only — synthesis is the
  // costly Haiku work, so it runs when interactive recall traffic is low. memrain's
  // idiomatic auto-think: opt the existing default-OFF SYNTHESIS_PHASES into the
  // schedule, count-capped (no USD budget, no deep-tier model — Claude Haiku only).
  const synthEnabled = process.env.MEMRAIN_DREAM_SYNTHESIS === "1";
  const synthCaps = synthEnabled
    ? {
        maxDocs: capEnv(process.env.MEMRAIN_DREAM_SYNTHESIS_MAX_DOCS, 25),
        maxConcepts: capEnv(process.env.MEMRAIN_DREAM_SYNTHESIS_MAX_CONCEPTS, 30),
        maxTakes: capEnv(process.env.MEMRAIN_DREAM_SYNTHESIS_MAX_TAKES, 25),
        minGraded: capEnv(process.env.MEMRAIN_DREAM_SYNTHESIS_MIN_GRADED, 5),
      }
    : undefined;
  const synthOnce = synthesisOncePerDay();

  const runTick = async (): Promise<void> => {
    if (stopped) return;
    const now = new Date();
    const inQuiet = isInQuietHours(now, quietStart, quietEnd);

    // Background sweep: reclaim a `memrain-cycle` lock stranded by a holder that
    // crashed (OOM/SIGKILL) on THIS host, so a dead row never blocks a tick for
    // the full TTL. tryAcquireDbLock only reclaims on contention; this is the
    // proactive sweep. Best-effort — never let it abort the tick.
    try {
      await reapDeadHolderLocks(storage.engine());
    } catch {
      /* best-effort sweep */
    }

    // Cross-process guard: another daemon (or a manual `cycle` run) may already
    // be working this brain. The DB lock serializes the maintenance pipeline so
    // two cycles don't fight over the same phases. A null handle means a live
    // holder owns the lock — skip this tick and re-arm the next one SOON (a
    // crashed cross-host holder's row TTL-expires within LOCK_TTL_MINUTES, then
    // the next tick's tryAcquireDbLock upsert reclaims it).
    let skipped = false;
    const lock = await tryAcquireDbLock(
      storage.engine(),
      CYCLE_LOCK_ID,
      LOCK_TTL_MINUTES,
    );
    if (!lock) {
      skipped = true;
      console.log(`[cycle] tick status=skipped reason=cycle_already_running (another holder owns ${CYCLE_LOCK_ID})`);
    } else {
      currentLock = lock;
      // Read under the lock: a holder that just finished has recorded its runs.
      const ranTodayUtc =
        synthEnabled && inQuiet && synthOnce ? await phasesRunTodayUtc(storage.engine(), now) : undefined;
      const phases = selectTickPhases({ inQuiet, synthEnabled, skipPhases, ...(ranTodayUtc ? { ranTodayUtc } : {}) });
      const opts: CycleOptions = {
        phases,
        staleDays,
        progress: consoleProgress("cycle"),
        storage,
        ...(synthCaps ? { synthesis: synthCaps } : {}),
      };
      // Heartbeat: refresh the lock every ~TTL/10 (30s for the 5 min TTL) so a
      // long run (a heavy embed-stale pass) cannot outlive the short TTL and let
      // a second cycle acquire concurrently. The short TTL is what lets a crashed
      // holder on ANY host be reclaimed fast; this refresh keeps a HEALTHY long
      // run alive under it, and its signal stops a run whose lock was taken.
      const heartbeat = startLockHeartbeat(lock);
      try {
        const r = await runCycleOnce(storage.engine(), { ...opts, signal: heartbeat.signal });
        const mark = (s: string) => (s === "fail" ? "FAIL" : s); // ok | warn | FAIL
        const summary = r.phases
          .map((p) => `${p.phase}=${mark(p.status)}`)
          .join(" ");
        const stopped = (r.outcome === "partial"
          ? ` reason=${r.reason ?? "aborted"} phasesNotRun=${(r.phasesNotRun ?? []).join(",") || "-"}`
          : "") + (r.orphanedPhase ? ` orphanedPhase=${r.orphanedPhase}` : "");
        console.log(
          `[cycle] tick status=${mark(r.status)} outcome=${r.outcome}${stopped} ${summary} duration=${
            new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
          }ms${inQuiet ? " (quiet — embed-stale skipped)" : ""}`,
        );
        // Opt-in (default-OFF) PAID deep-synthesis cadence: a Sonnet `think` pass
        // over the top synth_concepts as standing questions, USD-budget-capped.
        // Quiet hours only (heaviest + paid) and inside the held lock so it never
        // overlaps another cycle. Results are RETURNED (memrain writes nothing back);
        // logged for the operator. Fail-soft — never let it abort the tick.
        // A run that lost its lock must not start more paid work.
        if (inQuiet && r.outcome === "complete" && process.env.MEMRAIN_DEEP_SYNTH === "1") {
          try {
            const ds = await runDeepSynthUnderLock(storage, heartbeat.signal);
            if (ds.ran) {
              console.log(
                `[cycle] deep-synth: ${ds.syntheses.length}/${ds.questionsAsked} synthesized,` +
                  ` spent $${ds.spentUsd.toFixed(4)}` +
                  (ds.budgetExhausted ? " [budget exhausted]" : "") +
                  (heartbeat.signal.aborted ? ` [stopped: ${String(heartbeat.signal.reason)}]` : ""),
              );
            }
          } catch (e) {
            console.warn(
              `[cycle] deep-synth failed:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
      } catch (e) {
        console.warn(
          `[cycle] tick failed:`,
          e instanceof Error ? e.message : e,
        );
      } finally {
        heartbeat.stop();
        try {
          await lock.release();
        } catch (e) {
          // Swallow by design (TTL is the backstop), but say so — a stranded
          // lock row otherwise blocks ticks until expiry with zero diagnostic.
          console.error(
            `[cycle] lock release failed (row may persist until TTL expiry):`,
            e instanceof Error ? e.message : e,
          );
        }
        currentLock = null;
      }
    }
    if (!stopped) {
      timer = setTimeout(runTick, nextTickDelayMs(options.intervalMs, skipped));
    }
  };

  // First tick after a short boot-headroom delay (NOT the full interval) so a
  // brain redeployed more often than its interval still completes ticks.
  timer = setTimeout(runTick, firstTickDelayMs(options.intervalMs));

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Release a lock held by an in-flight tick BEFORE the caller closes the
      // engine (serve's shutdown does `await cycle.stop()` then `storage.close()`).
      // The tick's own `finally` would otherwise race the engine close. Idempotent
      // with that `finally`; either order leaves the row deleted. NOTE: this does
      // NOT await the in-flight tick — it releases the lock while the tick may
      // still be running, which is safe ONLY because the sole caller (serve's
      // shutdown) closes the engine and exits immediately after. In a keep-alive
      // context this would let a competitor acquire mid-work; don't reuse it so.
      if (currentLock) {
        try {
          await currentLock.release();
        } catch (e) {
          // Swallow by design (TTL is the backstop), but say so — a stranded
          // lock row otherwise blocks ticks until expiry with zero diagnostic.
          console.error(
            `[cycle] lock release failed on stop (row may persist until TTL expiry):`,
            e instanceof Error ? e.message : e,
          );
        }
        currentLock = null;
      }
    },
  };
}
