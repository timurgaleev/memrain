/**
 * Cycle — runs the maintenance phases (see ALL_PHASES) in order, returns a
 * per-phase envelope. Phases are independent: one failing doesn't stop others.
 */
import { type BatchScope, runInBatchScope } from "../llm/bedrock-errors.ts";
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { type ProgressSink, NOOP_PROGRESS } from "../output/progress.ts";
import {
  embedStalePhase,
  type EmbedStaleOptions,
  type EmbedStaleResult,
} from "./embed-stale.ts";
import {
  embedGapsPhase,
  type EmbedGapsOptions,
  type EmbedGapsResult,
} from "./embed-gaps.ts";
import { extractPhase, type ExtractPhaseOptions } from "./extract.ts";
import { embedFactsPhase, type EmbedFactsResult } from "./embed-facts.ts";
import {
  reconcileLinksPhase,
  type ReconcileLinksResult,
} from "./reconcile-links.ts";
import {
  orphansPurgePhase,
  type OrphansPurgeResult,
} from "./orphans-purge.ts";
import {
  recomputeSaliencePhase,
  type RecomputeSalienceResult,
} from "./recompute-salience.ts";
import {
  extractMeetingTimelinePhase,
  type MeetingTimelineResult,
} from "../timeline-meetings.ts";
import {
  timelineAnchorPhase,
  type TimelineAnchorResult,
} from "../timeline-anchor.ts";
import { snapshotPhase, type SnapshotResult } from "./snapshot.ts";
import {
  mirrorPagesPhase,
  type MirrorPagesResult,
} from "./mirror-pages.ts";
import { purgePhase, type PurgeResult } from "./purge.ts";
import { lintPhase, type LintPhaseResult } from "./lint.ts";
import {
  resolveSymbolEdgesPhase,
  type ResolveSymbolEdgesResult,
} from "./resolve-symbol-edges.ts";
import type { ExtractResult } from "../extract.ts";
import {
  extractAtomsPhase,
  type ExtractAtomsResult,
} from "../synthesis/atoms.ts";
import {
  synthesizeConceptsPhase,
  type SynthesizeConceptsResult,
} from "../synthesis/concepts.ts";
import {
  proposeTakesPhase,
  gradeTakesPhase,
  type ProposeTakesResult,
  type GradeTakesResult,
} from "../synthesis/takes.ts";
import {
  calibrationProfilePhase,
  type CalibrationProfileResult,
} from "../synthesis/calibration.ts";
import {
  probeContradictionsPhase,
  type ProbeContradictionsResult,
} from "../synthesis/contradictions.ts";
import {
  reflectionsPhase,
  type ReflectionsPhaseResult,
} from "../synthesis/reflections.ts";
import {
  patternsPhase,
  type PatternsPhaseResult,
} from "../synthesis/patterns.ts";
import {
  enrichThinPhase,
  type EnrichThinPhaseResult,
} from "../synthesis/enrich-thin.ts";
import {
  autoThinkPhase,
  type AutoThinkPhaseResult,
} from "../synthesis/auto-think.ts";
import {
  driftPhase,
  type DriftPhaseResult,
} from "../synthesis/drift.ts";
import {
  consolidateFactsPhase,
  type ConsolidateFactsResult,
} from "./consolidate-facts.ts";
import {
  conversationFactsBackfillPhase,
  type ConversationFactsBackfillResult,
} from "./conversation-facts-backfill.ts";
import {
  rechunkSweepPhase,
  type RechunkSweepResult,
} from "./rechunk-sweep.ts";
import type { LlmFn } from "../llm/haiku.ts";
import { heldLockOf } from "../db-lock.ts";
import { runInPhaseContext } from "./phase-context.ts";
import { recordPhaseRun } from "./phase-runs.ts";
import { runWithSpendTags } from "../budget.ts";

export type PhaseName =
  | "lint"
  | "embed-stale"
  | "embed-gaps"
  | "mirror-pages"
  | "embed-facts"
  | "extract"
  | "resolve-symbol-edges"
  | "reconcile-links"
  | "orphans-purge"
  | "recompute-salience"
  | "extract-timeline"
  | "timeline-anchor"
  | "snapshot"
  | "purge"
  // Synthesis phases (Wave 5) — opt-in, LLM-backed, default-OFF (NOT in
  // ALL_PHASES). Run only when explicitly requested via options.phases.
  | "extract-atoms"
  | "synthesize-concepts"
  | "propose-takes"
  | "grade-takes"
  | "calibration-profile"
  | "probe-contradictions"
  | "reflections"
  | "patterns"
  // Autopilot synthesis phases — opt-in, paid, each default-OFF behind its own
  // env flag (MEMRAIN_ENRICH_THIN / MEMRAIN_AUTO_THINK / MEMRAIN_DRIFT). NOT in
  // ALL_PHASES.
  | "enrich-thin"
  | "auto-think"
  | "drift"
  // Facts-maintenance phases — opt-in, default-OFF (NOT in ALL_PHASES).
  // consolidate-facts is deterministic + free; conversation-facts-backfill is
  // paid (Sonnet) and additionally gated by MEMRAIN_FACTS_BACKFILL.
  | "consolidate-facts"
  | "conversation-facts-backfill"
  // Chunker-maintenance sweep — opt-in, default-OFF (NOT in ALL_PHASES). Spends
  // Bedrock Titan re-embedding chunker-version-stale docs, so it is gated by its
  // own env flag (MEMRAIN_RECHUNK_SWEEP) and count/char-capped per tick.
  | "rechunk-sweep";

export const ALL_PHASES: readonly PhaseName[] = [
  "lint",
  "embed-stale",
  "embed-gaps",
  "mirror-pages",
  "embed-facts",
  "extract",
  "resolve-symbol-edges",
  "reconcile-links",
  "orphans-purge",
  "recompute-salience",
  "extract-timeline",
  "timeline-anchor",
  "snapshot",
  "purge",
];

/**
 * Opt-in LLM-synthesis phases (Wave 5). Deliberately NOT in ALL_PHASES — they
 * spend Bedrock and only run when explicitly requested (`memrain cycle --phases
 * extract-atoms,...`). Listed here so the CLI accepts them as valid phase names
 * while the default cycle stays free + deterministic.
 */
export const SYNTHESIS_PHASES: readonly PhaseName[] = [
  "extract-atoms",
  "synthesize-concepts",
  "propose-takes",
  "grade-takes",
  "calibration-profile",
  "probe-contradictions",
  // reflections runs BEFORE patterns so a fresh brain can populate reflections/
  // and then mine them for cross-session themes in the same tick.
  "reflections",
  "patterns",
  // Autopilot page-writers — each no-ops unless its own env flag is set, so
  // including them in the synthesis batch is safe (they self-gate).
  "enrich-thin",
  "auto-think",
  "drift",
];

/**
 * Opt-in facts-maintenance phases. Like SYNTHESIS_PHASES, deliberately NOT in
 * ALL_PHASES — they run only when explicitly requested. `consolidate-facts` is
 * deterministic + free; `conversation-facts-backfill` spends Bedrock and is
 * additionally gated by the MEMRAIN_FACTS_BACKFILL env flag.
 */
export const FACTS_MAINT_PHASES: readonly PhaseName[] = [
  "consolidate-facts",
  "conversation-facts-backfill",
];

/**
 * Chunker-maintenance sweep phase. Like the other opt-in lists, deliberately
 * NOT in ALL_PHASES — it re-embeds via Bedrock and only runs when explicitly
 * requested (`memrain cycle --phases rechunk-sweep`) AND enabled via its own env
 * flag (MEMRAIN_RECHUNK_SWEEP). Requesting it without the flag is a safe no-op
 * (the phase returns `ran:false`). Listed here so the CLI accepts the name.
 */
export const CHUNKER_SWEEP_PHASES: readonly PhaseName[] = ["rechunk-sweep"];

/**
 * Three-state phase outcome (ok/warn/fail envelope). `warn` = the phase
 * COMPLETED (didn't throw) but reported
 * non-fatal issues — e.g. embed-stale re-embedded most chunks but a few hit
 * a transient Bedrock error, or snapshot computed but couldn't persist. A
 * warn does NOT fail the cycle; it surfaces a partial success that the old
 * binary `ok` silently swallowed.
 */
export type PhaseStatus = "ok" | "warn" | "fail";

export interface PhaseResult {
  phase: PhaseName;
  /** Back-compat: true unless the phase threw. A `warn` is still `ok:true`. */
  ok: boolean;
  /** Three-state outcome — prefer this over `ok` for new consumers. */
  status: PhaseStatus;
  durationMs: number;
  detail?:
    | EmbedStaleResult
    | EmbedGapsResult
    | EmbedFactsResult
    | ExtractResult
    | ReconcileLinksResult
    | OrphansPurgeResult
    | RecomputeSalienceResult
    | MeetingTimelineResult
    | TimelineAnchorResult
    | MirrorPagesResult
    | PurgeResult
    | LintPhaseResult
    | ResolveSymbolEdgesResult
    | SnapshotResult
    | ExtractAtomsResult
    | SynthesizeConceptsResult
    | ProposeTakesResult
    | GradeTakesResult
    | CalibrationProfileResult
    | ProbeContradictionsResult
    | ReflectionsPhaseResult
    | PatternsPhaseResult
    | EnrichThinPhaseResult
    | AutoThinkPhaseResult
    | DriftPhaseResult
    | ConsolidateFactsResult
    | ConversationFactsBackfillResult
    | RechunkSweepResult;
  error?: string;
  /** The phase was aborted or hit its deadline and its own work had not wound
   *  down when the run returned: its database writes may still land. */
  orphaned?: true;
}

/**
 * Why a cycle did not run to completion. `cycle_already_running`: another
 * holder owned the cycle lock, so nothing ran. `lock_stolen`: the lock was
 * taken mid-run and the run stopped. `aborted`: any other abort.
 */
export type CycleReason = "cycle_already_running" | "lock_stolen" | "aborted";

const CYCLE_REASONS: ReadonlySet<string> = new Set<CycleReason>([
  "cycle_already_running",
  "lock_stolen",
  "aborted",
]);

/** Bumped whenever the report shape changes, so a consumer can tell them apart. */
export const CYCLE_REPORT_SCHEMA_VERSION = 2;

export type CycleOutcome = "complete" | "partial" | "skipped";

export interface CycleResult {
  schemaVersion: typeof CYCLE_REPORT_SCHEMA_VERSION;
  startedAt: string;
  finishedAt: string;
  /** complete: every requested phase ran; partial: the run stopped early;
   *  skipped: nothing ran. Independent of the phases' own status. */
  outcome: CycleOutcome;
  /** Set whenever outcome is not complete. */
  reason?: CycleReason;
  /** Requested phases that never started, in request order. */
  phasesNotRun?: PhaseName[];
  phases: PhaseResult[];
  /** Set when an abort or a phase deadline left a phase still running after the
   *  report was built (see PhaseResult.orphaned). Its paid calls are stopped;
   *  its DB work is not. */
  orphanedPhase?: PhaseName;
  /** Back-compat: true unless a phase FAILED (warns don't flip it). A partial
   *  run is false. */
  ok: boolean;
  /** Worst phase outcome: fail if any failed, else warn if any warned, else ok.
   *  A partial run is fail. */
  status: PhaseStatus;
}

/** Phase results the abort cut short. Kept off the report so its shape stays
 *  put; runCycleOnce reads it to tell a stopped run from one whose abort only
 *  landed after its last phase had already finished. */
const interruptedPhases = new WeakSet<PhaseResult>();

function cycleReasonOf(signal: AbortSignal): CycleReason {
  const r: unknown = signal.reason;
  return typeof r === "string" && CYCLE_REASONS.has(r) ? (r as CycleReason) : "aborted";
}

/** The report for a cycle that never started (e.g. the lock was held). Not a
 *  failure: ok stays true, the outcome says why nothing ran. */
export function skippedCycleResult(reason: CycleReason, phasesNotRun?: PhaseName[]): CycleResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: CYCLE_REPORT_SCHEMA_VERSION,
    startedAt: now,
    finishedAt: now,
    outcome: "skipped",
    reason,
    ...(phasesNotRun ? { phasesNotRun: [...phasesNotRun] } : {}),
    phases: [],
    ok: true,
    status: "ok",
  };
}

/**
 * Derive a SUCCEEDED phase's status from its detail. Explicit per-phase
 * rules (not duck-typing) so the warn signal is precise:
 *   - embed-stale / extract: any per-document error → warn (the phase still
 *     succeeds on the rest; those failures are transient/recoverable next
 *     cycle). Both carry the identical `{ errors: [...] }` shape.
 *   - snapshot: computed but not persisted → warn (soft failure).
 *   - orphans-purge: a `docs_with_zero_chunks` entry is a CORRUPT index row
 *     (a document with no chunks) → warn. `docs_missing_on_disk` is left as
 *     `ok`: a file deleted/renamed between syncs is routine churn the purge
 *     handles, not an anomaly (would be noisy as a warn).
 * reconcile-links `unresolved` is BY DESIGN informational (a wikilink to a
 * not-yet-created page is normal), so it stays `ok`; so does lint `flagged`,
 * which no phase repairs.
 */
export function deriveStatus(
  phase: PhaseName,
  detail: PhaseResult["detail"],
): PhaseStatus {
  const status = derivePhaseRuleStatus(phase, detail);
  return status === "ok" && reportsAbsorbedFailures(detail) ? "warn" : status;
}

/**
 * A phase that caught its own failures and still returned must not read as a
 * clean run: a non-empty `errors`, or a positive `failed` count, is a warn for
 * every phase, whether or not it has an explicit rule below. `rejected` is not
 * a failure: embed-stale and rechunk-sweep count re-read guard refusals there
 * (a denied name, another owner, a path outside the roots), which repeat every
 * cycle by policy and would pin both phases at warn for good.
 */
function reportsAbsorbedFailures(detail: PhaseResult["detail"]): boolean {
  if (!detail || typeof detail !== "object") return false;
  const d = detail as { errors?: unknown; failed?: unknown };
  if (Array.isArray(d.errors) && d.errors.length > 0) return true;
  return typeof d.failed === "number" && d.failed > 0;
}

function derivePhaseRuleStatus(
  phase: PhaseName,
  detail: PhaseResult["detail"],
): PhaseStatus {
  if (
    phase === "embed-stale" ||
    phase === "embed-facts" ||
    phase === "extract" ||
    phase === "mirror-pages" ||
    phase === "resolve-symbol-edges" ||
    phase === "rechunk-sweep"
  ) {
    const errs = (
      detail as
        | EmbedStaleResult
        | EmbedFactsResult
        | ExtractResult
        | MirrorPagesResult
        | ResolveSymbolEdgesResult
        | RechunkSweepResult
        | undefined
    )?.errors;
    return Array.isArray(errs) && errs.length > 0 ? "warn" : "ok";
  }
  if (phase === "snapshot") {
    return (detail as SnapshotResult | undefined)?.persisted === false
      ? "warn"
      : "ok";
  }
  if (phase === "lint") {
    // Conformance debt nothing in the cycle can repair: a standing warn would
    // tell nobody what to do and mask a real regression, so the counts stay in
    // the detail and the phase reads ok, like reconcile-links `unresolved`.
    return "ok";
  }
  if (phase === "orphans-purge") {
    const zero = (detail as OrphansPurgeResult | undefined)?.flagged
      ?.docs_with_zero_chunks;
    // docs_with_relative_source_path is deliberately NOT part of the status.
    // Path shape cannot tell a legacy file row from a supported one: the inline
    // MCP write (`index` with sourcePath + text) keeps the caller's own label,
    // which is correct and common — the live brain holds several. Escalating on
    // shape alone would pin the cycle at warn forever on a healthy corpus,
    // which is the same false-positive this phase was already fixed for once.
    return Array.isArray(zero) && zero.length > 0 ? "warn" : "ok";
  }
  if (
    phase === "extract-atoms" ||
    phase === "synthesize-concepts" ||
    phase === "propose-takes" ||
    phase === "grade-takes" ||
    phase === "calibration-profile" ||
    phase === "probe-contradictions" ||
    phase === "reflections" ||
    phase === "patterns" ||
    phase === "enrich-thin" ||
    phase === "auto-think" ||
    phase === "drift" ||
    phase === "consolidate-facts" ||
    phase === "conversation-facts-backfill"
  ) {
    // These phases fail-open per item: a non-empty errors[] means some work
    // failed but the run completed → warn (never fails the cycle).
    const errs = (detail as { errors?: unknown[] } | undefined)?.errors;
    return Array.isArray(errs) && errs.length > 0 ? "warn" : "ok";
  }
  // reconcile-links, recompute-salience, extract-timeline: no failure-bearing detail — they either complete or throw
  // (a single failed write aborts the whole phase → caught as fail above), so a
  // SUCCEEDED run is always ok. A NEW phase falls here too: add an explicit rule
  // above if it can partially fail, rather than letting it default to ok
  // unnoticed.
  return "ok";
}

export interface CycleOptions {
  /** Limit which phases to run. Default = all. */
  phases?: PhaseName[];
  /**
   * Storage handle for phases that need Storage-level helpers (the slug
   * resolver + timeline writer). The recipe always passes it; when absent
   * (e.g. an engine-only test harness) the `extract-timeline` phase no-ops.
   */
  storage?: Storage;
  /** Forwarded to embed-stale. */
  staleDays?: number;
  /** Forwarded to embed-stale. */
  embedMaxPerCycle?: number;
  /** Forwarded to embed-gaps (its cap and the test seam). */
  embedGaps?: EmbedGapsOptions;
  /** Forwarded to extract. */
  extractMaxDocs?: number;
  /**
   * Synthesis knobs (Wave 5 LLM phases). All optional; `llmFn` is the test
   * seam (omitted in prod → the real Bedrock Claude Haiku client). Caps bound LLM
   * spend per run.
   */
  synthesis?: {
    llmFn?: LlmFn;
    modelId?: string;
    maxDocs?: number;
    maxConcepts?: number;
    maxTakes?: number;
    minGraded?: number;
  };
  /** Optional progress sink. */
  progress?: ProgressSink;
  /**
   * Stops the run: checked before every phase, and an abort during a phase
   * halts its paid Bedrock calls at once, fails the phase, and stops the
   * phase's own loops at their next checkpoint (see phase-context.ts). The run
   * waits up to ABORT_SETTLE_MS for the phase to wind down and reports
   * `orphanedPhase` if it is still going. The cycle lock heartbeat aborts it
   * with `lock_stolen`.
   */
  signal?: AbortSignal;
  /**
   * Checks that the cycle lock is still ours; phases call it before writes to
   * shared state, and a false answer stops the run as `lock_stolen`. Defaults
   * to the lock behind `signal` when that is a lock heartbeat's signal.
   */
  fence?: () => Promise<boolean>;
}

// Per-phase wall-clock deadline. A phase that hangs (e.g. a Bedrock/Haiku call
// with no client timeout) otherwise wedges the WHOLE tick: `await fn()` never
// returns, the phase loop never advances, runCycleOnce never resolves, and the
// cycle loop's `finally` never releases the db-lock — so the maintenance cycle
// stalls until the lock TTL lapses and stays stuck every subsequent tick.
// Default 15 min (generous for a large embed-stale backlog under its per-cycle
// cap); `MEMRAIN_CYCLE_PHASE_TIMEOUT_MS=0` disables. A timed-out phase is recorded
// as `fail` and the cycle proceeds to its remaining phases (incl. snapshot) and
// releases the lock — liveness over the leaked in-flight work, which the run
// waits ABORT_SETTLE_MS for and reports as `orphaned` if it is still going.
function phaseTimeoutMs(): number {
  const raw = process.env.MEMRAIN_CYCLE_PHASE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 15 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15 * 60 * 1000;
}

/** A phase that blew its deadline. Its own promise keeps running, so runPhase
 *  waits for it the way it waits after an abort before marking it orphaned. */
export class PhaseTimeoutError extends Error {}

export function withPhaseTimeout<T>(
  phase: PhaseName,
  fn: () => Promise<T>,
  ms: number = phaseTimeoutMs(),
): Promise<T> {
  if (ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PhaseTimeoutError(`phase ${phase} timed out after ${ms}ms`)),
      ms,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Force a full GC between phases. On the small live host (~3.7 GB) the cycle's
// cumulative working set — un-GC'd phase garbage + page cache — climbed across
// phases and tripped the container mem_limit (cgroup OOM-kill of PID 1, silent
// SIGKILL mid-phase, no JS exception). Reclaiming each phase's
// intermediate allocations before the next starts lowers the cumulative peak so
// the cycle fits. Bun-only (`Bun.gc`); a no-op elsewhere. Disable with
// MEMRAIN_CYCLE_GC=0.
function reclaimBetweenPhases(): void {
  if (process.env.MEMRAIN_CYCLE_GC === "0") return;
  const g = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  try {
    g?.gc?.(true);
  } catch {
    /* best-effort — GC is an optimisation, never fail the cycle on it */
  }
}

/**
 * Settle with `work`, or reject with `aborted: <reason>` as soon as `signal`
 * aborts. `onAbort` runs first so the caller can halt the orphaned work.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new Error(`aborted: ${cycleReasonOf(signal)}`));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}

/**
 * How long runPhase waits, after an abort, for the phase's own promise to wind
 * down. Paid calls stop at once through the batch scope, but the phase's DB
 * work (extract writes, purge deletes) does not; waiting a bounded moment lets
 * the usual in-flight batch finish before the caller releases the lock or
 * closes the engine, without letting a wedged phase hold the run hostage.
 */
export const ABORT_SETTLE_MS = 10_000;

/** Resolves true once `p` settles, false if `ms` passes first. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, ms, false);
    (timer as unknown as { unref?: () => void }).unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}

/**
 * Run `fn` as batch work whose paid Bedrock calls stop once `signal` aborts.
 * For paid work that runs under the cycle lock outside runCycleOnce (the
 * deep-synth pass): the heartbeat's abort must reach it too.
 */
export async function runInAbortableBatchScope<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: BatchScope = {
    stopped: signal.aborted,
    circuit: true,
    ...(signal.aborted ? { stopReason: cycleReasonOf(signal) } : {}),
  };
  const stop = () => {
    scope.stopped = true;
    scope.stopReason = cycleReasonOf(signal);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await runInBatchScope(scope, fn);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

const WARN_ERROR_LOG_CAP = 5;
const WARN_MESSAGE_MAX = 160;

function clip(text: string): string {
  return text.length > WARN_MESSAGE_MAX ? `${text.slice(0, WARN_MESSAGE_MAX)}…` : text;
}

/** One `errors[]` entry as `"<where>": "<message>"`, whatever the phase's shape. */
function describePhaseError(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    const where = e["sourcePath"] ?? e["path"] ?? e["slug"] ?? e["id"] ?? e["source_id"];
    const message = JSON.stringify(clip(String(e["message"] ?? JSON.stringify(entry))));
    return where === undefined ? message : `${JSON.stringify(String(where))}: ${message}`;
  }
  return JSON.stringify(clip(String(entry)));
}

/**
 * Why a phase ended in warn: a short summary plus log lines naming the first
 * few failing rows (capped, so a phase failing on every row cannot flood the
 * log).
 */
export function phaseWarnDetail(detail: PhaseResult["detail"]): { summary: string; lines: string[] } {
  if (!detail || typeof detail !== "object") return { summary: "", lines: [] };
  const d = detail as {
    errors?: unknown;
    failed?: unknown;
    persisted?: unknown;
    flagged?: { docs_with_zero_chunks?: unknown };
  };
  const parts: string[] = [];
  const lines: string[] = [];
  if (Array.isArray(d.errors) && d.errors.length > 0) {
    parts.push(`errors=${d.errors.length}`);
    for (const entry of d.errors.slice(0, WARN_ERROR_LOG_CAP)) {
      lines.push(`error ${describePhaseError(entry)}`);
    }
    if (d.errors.length > WARN_ERROR_LOG_CAP) {
      lines.push(`error ... and ${d.errors.length - WARN_ERROR_LOG_CAP} more`);
    }
  }
  if (typeof d.failed === "number" && d.failed > 0) parts.push(`failed=${d.failed}`);
  if (d.persisted === false) parts.push("persisted=false");
  const zero = d.flagged?.docs_with_zero_chunks;
  if (Array.isArray(zero) && zero.length > 0) parts.push(`docs_with_zero_chunks=${zero.length}`);
  const summary = parts.join(" ");
  return { summary, lines: summary ? [summary, ...lines] : lines };
}

export async function runPhase<T>(
  engine: Engine,
  phase: PhaseName,
  fn: () => Promise<T>,
  progress: ProgressSink,
  signal?: AbortSignal,
  settleMs: number = ABORT_SETTLE_MS,
  fence?: () => Promise<boolean>,
): Promise<PhaseResult> {
  const start = Date.now();
  progress({ kind: "phase", op: "cycle", phase, ts: start });
  // A phase that times out or is aborted keeps running (JS cannot cancel
  // it): the scope flag stops its orphaned paid calls from spending past the
  // cutoff, and the phase signal stops its own loops at their next checkpoint.
  const scope: BatchScope = { stopped: false, circuit: true };
  const phaseStop = new AbortController();
  const stop = (reason: string = scope.stopReason ?? "phase_stopped") => {
    scope.stopped = true;
    if (!phaseStop.signal.aborted) phaseStop.abort(reason);
  };
  let aborted = false;
  let orphaned = false;
  // The phase's own promise is kept apart from the deadline wrapper: once the
  // deadline rejects, only this one still tracks the work that is still going.
  // The spend tag puts the phase's paid calls under the cycle daily cap and
  // names the phase on each ledger row.
  const work = runInBatchScope(scope, () =>
    runInPhaseContext({ phase, signal: phaseStop.signal, ...(fence ? { fence } : {}) }, () =>
      runWithSpendTags({ phase }, fn),
    ),
  );
  const deadlined = withPhaseTimeout(phase, () => work);
  try {
    const onAbort = () => {
      aborted = true;
      if (signal) scope.stopReason = cycleReasonOf(signal);
      stop();
    };
    const detail = (await raceAbort(deadlined, signal, onAbort).catch((e: unknown) => {
      stop(e instanceof PhaseTimeoutError ? "phase_timeout" : undefined);
      throw e;
    })) as PhaseResult["detail"];
    const status = deriveStatus(phase, detail);
    // Per-phase memory telemetry: a live OOM (a bun cycle process hit 3.48 GB
    // RSS → kernel kill mid-tick) needs the spiking phase named. Cheap; on by
    // default, silence with MEMRAIN_CYCLE_RSS_LOG=0.
    if (process.env.MEMRAIN_CYCLE_RSS_LOG !== "0") {
      const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      console.error(`[cycle] phase ${phase} done status=${status} rss=${rssMb}MB dur=${Date.now() - start}ms`);
    }
    reclaimBetweenPhases();
    if (status === "warn") {
      const why = phaseWarnDetail(detail);
      // The tick line only says `warn`; without the reason in the log a
      // repeating warn cannot be traced back to the rows that cause it.
      for (const line of why.lines) console.error(`[cycle] phase ${phase} warn: ${line}`);
      progress({
        kind: "log",
        op: "cycle",
        level: "warn",
        message: `phase ${phase} completed with warnings${why.summary ? ` (${why.summary})` : ""}`,
        ts: Date.now(),
      });
    }
    await recordPhaseRun(engine, phase, status);
    return {
      phase,
      ok: true,
      status,
      durationMs: Date.now() - start,
      detail,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A deadline leaves the phase running exactly as an abort does, so it gets
    // the same settle window and the same marker: without it the report showed
    // a plain fail while the phase kept writing past the cycle's lock.
    const timedOut = e instanceof PhaseTimeoutError;
    if ((aborted || timedOut) && !(await settlesWithin(work, settleMs))) {
      orphaned = true;
      console.error(
        `[cycle] phase ${phase} still running ${settleMs}ms after ${timedOut ? "its deadline" : "abort"} — paid calls are stopped, its database work is not`,
      );
    }
    reclaimBetweenPhases();
    progress({
      kind: "log",
      op: "cycle",
      level: "error",
      message: `phase ${phase} failed: ${error}`,
      ts: Date.now(),
    });
    const result: PhaseResult = {
      phase,
      ok: false,
      status: "fail",
      durationMs: Date.now() - start,
      error,
      ...(orphaned ? { orphaned: true as const } : {}),
    };
    if (aborted) interruptedPhases.add(result);
    // A failed run is still a run: what it spent before failing counts toward
    // the once-a-day rule.
    await recordPhaseRun(engine, phase, "fail");
    return result;
  }
}

export async function runCycleOnce(
  engine: Engine,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const progress = options.progress ?? NOOP_PROGRESS;
  const requested = options.phases ?? ALL_PHASES;
  const startedAt = new Date().toISOString();
  progress({ kind: "started", op: "cycle", ts: Date.now() });

  // The run's own signal follows the caller's and is also aborted when a phase
  // finds the lock gone, so a steal the heartbeat has not seen yet still stops
  // the run.
  const run = new AbortController();
  const outer = options.signal;
  const follow = () => run.abort(outer?.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener("abort", follow, { once: true });
  const signal = run.signal;
  const lockCheck = options.fence ?? heldLockOf(outer)?.isHeld;
  const fence = lockCheck
    ? async () => {
        const held = await lockCheck();
        if (!held && !run.signal.aborted) run.abort("lock_stolen");
        return held;
      }
    : undefined;
  try {
    return await runPhases(engine, options, progress, requested, startedAt, signal, fence);
  } finally {
    outer?.removeEventListener("abort", follow);
  }
}

async function runPhases(
  engine: Engine,
  options: CycleOptions,
  progress: ProgressSink,
  requested: readonly PhaseName[],
  startedAt: string,
  signal: AbortSignal,
  fence: (() => Promise<boolean>) | undefined,
): Promise<CycleResult> {
  const runFenced = <T>(
    e: Engine,
    p: PhaseName,
    fn: () => Promise<T>,
    sink: ProgressSink,
    sig: AbortSignal | undefined,
  ) => runPhase(e, p, fn, sink, sig, ABORT_SETTLE_MS, fence);
  const phases: PhaseResult[] = [];
  const phasesNotRun: PhaseName[] = [];
  for (const p of requested) {
    if (signal.aborted) {
      phasesNotRun.push(p);
      continue;
    }
    let r: PhaseResult;
    switch (p) {
      case "lint":
        r = await runFenced(engine, p, () => lintPhase(engine), progress, signal);
        break;
      case "embed-stale": {
        const o: EmbedStaleOptions = {};
        if (options.staleDays !== undefined) o.staleDays = options.staleDays;
        if (options.embedMaxPerCycle !== undefined)
          o.maxPerCycle = options.embedMaxPerCycle;
        r = await runFenced(engine, p, () => embedStalePhase(engine, o), progress, signal);
        break;
      }
      case "embed-gaps":
        r = await runFenced(engine, p, () => embedGapsPhase(engine, options.embedGaps ?? {}), progress, signal);
        break;
      case "mirror-pages": {
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? mirrorPagesPhase(storage)
              : Promise.resolve<MirrorPagesResult>({
                  scanned: 0,
                  mirrored: 0,
                  removed: 0,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      case "embed-facts":
        r = await runFenced(engine, p, () => embedFactsPhase(engine), progress, signal);
        break;
      case "extract": {
        const o: ExtractPhaseOptions = {};
        if (options.extractMaxDocs !== undefined) o.maxDocs = options.extractMaxDocs;
        r = await runFenced(engine, p, () => extractPhase(engine, o), progress, signal);
        break;
      }
      case "resolve-symbol-edges":
        r = await runFenced(engine, p, () => resolveSymbolEdgesPhase(engine), progress, signal);
        break;
      case "reconcile-links":
        r = await runFenced(engine, p, () => reconcileLinksPhase(engine), progress, signal);
        break;
      case "orphans-purge":
        r = await runFenced(engine, p, () => orphansPurgePhase(engine), progress, signal);
        break;
      case "recompute-salience":
        r = await runFenced(
          engine,
          p,
          () => recomputeSaliencePhase(engine),
          progress,
          signal,
        );
        break;
      case "extract-timeline": {
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? extractMeetingTimelinePhase(storage)
              : Promise.resolve<MeetingTimelineResult>({
                  meetings_scanned: 0,
                  entries_written: 0,
                  attendees_touched: 0,
                }),
          progress,
          signal,
        );
        break;
      }
      case "timeline-anchor": {
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? timelineAnchorPhase(storage)
              : Promise.resolve<TimelineAnchorResult>({
                  pages_scanned: 0,
                  events_written: 0,
                }),
          progress,
          signal,
        );
        break;
      }
      case "snapshot":
        r = await runFenced(engine, p, () => snapshotPhase(engine), progress, signal);
        break;
      case "purge":
        r = await runFenced(engine, p, () => purgePhase(engine), progress, signal);
        break;
      // Synthesis phases (Wave 5) — LLM-backed, opt-in. Order matters:
      // atoms -> concepts -> takes -> grade -> calibration.
      case "extract-atoms":
        r = await runFenced(
          engine,
          p,
          // Storage enables the atoms/<date>/<slug> page mirror (retrievable
          // atoms); without it the phase writes synth_atoms rows only.
          () =>
            extractAtomsPhase(engine, {
              ...(options.synthesis ?? {}),
              ...(options.storage ? { storage: options.storage } : {}),
            }),
          progress,
          signal,
        );
        break;
      case "synthesize-concepts":
        r = await runFenced(
          engine,
          p,
          // Storage enables the concepts/<slug> page mirror.
          () =>
            synthesizeConceptsPhase(engine, {
              ...(options.synthesis ?? {}),
              ...(options.storage ? { storage: options.storage } : {}),
            }),
          progress,
          signal,
        );
        break;
      case "propose-takes":
        r = await runFenced(
          engine,
          p,
          () => proposeTakesPhase(engine, options.synthesis ?? {}),
          progress,
          signal,
        );
        break;
      case "grade-takes":
        r = await runFenced(
          engine,
          p,
          () => gradeTakesPhase(engine, options.synthesis ?? {}),
          progress,
          signal,
        );
        break;
      case "calibration-profile":
        r = await runFenced(
          engine,
          p,
          () => calibrationProfilePhase(engine, options.synthesis ?? {}),
          progress,
          signal,
        );
        break;
      case "probe-contradictions":
        r = await runFenced(
          engine,
          p,
          // Paid Sonnet, default-OFF (gated on MEMRAIN_PROBE_CONTRADICTIONS). Reads
          // its own model/budget from env; no Haiku synthesis seam applies here.
          () => probeContradictionsPhase(engine, {}),
          progress,
          signal,
        );
        break;
      case "reflections": {
        // Paid Sonnet, default-OFF (MEMRAIN_REFLECTIONS). Writes real
        // reflections/<slug> pages, so it needs the Storage handle (putPage).
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? reflectionsPhase(storage, {})
              : Promise.resolve<ReflectionsPhaseResult>({
                  ran: false,
                  reason: "no storage handle",
                  transcriptsConsidered: 0,
                  reflectionsWritten: 0,
                  worthSkipped: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      case "patterns": {
        // Paid Sonnet, default-OFF (MEMRAIN_PATTERNS). Writes real patterns/<slug>
        // pages, so it needs the Storage handle (putPage), not just the engine.
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? patternsPhase(storage, {})
              : Promise.resolve<PatternsPhaseResult>({
                  ran: false,
                  reason: "no storage handle",
                  reflectionsConsidered: 0,
                  patternsWritten: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      case "enrich-thin": {
        // Paid Sonnet, default-OFF (MEMRAIN_ENRICH_THIN). Rewrites real pages in
        // place, so it needs the Storage handle (putPage).
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? enrichThinPhase(storage, {})
              : Promise.resolve<EnrichThinPhaseResult>({
                  ran: false,
                  reason: "no storage handle",
                  thinPagesConsidered: 0,
                  pagesEnriched: 0,
                  pagesSkippedInsufficient: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      case "auto-think": {
        // Paid Sonnet, default-OFF (MEMRAIN_AUTO_THINK). Writes drafts/think/ pages.
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? autoThinkPhase(storage, {})
              : Promise.resolve<AutoThinkPhaseResult>({
                  ran: false,
                  reason: "no storage handle",
                  questionsConsidered: 0,
                  draftsWritten: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      case "drift": {
        // Paid Sonnet, default-OFF (MEMRAIN_DRIFT). Writes a drift-reports/ page.
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? driftPhase(storage, {})
              : Promise.resolve<DriftPhaseResult>({
                  ran: false,
                  reason: "no storage handle",
                  candidatesConsidered: 0,
                  driftedFlagged: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      // Facts-maintenance phases — opt-in, default-OFF (see FACTS_MAINT_PHASES).
      case "consolidate-facts":
        r = await runFenced(engine, p, () => consolidateFactsPhase(engine), progress, signal);
        break;
      case "conversation-facts-backfill": {
        const storage = options.storage;
        r = await runFenced(
          engine,
          p,
          () =>
            storage
              ? conversationFactsBackfillPhase(storage)
              : Promise.resolve<ConversationFactsBackfillResult>({
                  ran: false,
                  reason: "no storage handle",
                  pagesConsidered: 0,
                  pagesProcessed: 0,
                  factsWritten: 0,
                  zeroYieldRecorded: 0,
                  worthSkipped: 0,
                  spentUsd: 0,
                  budgetExhausted: false,
                  errors: [],
                }),
          progress,
          signal,
        );
        break;
      }
      // Chunker-maintenance sweep — opt-in, default-OFF (MEMRAIN_RECHUNK_SWEEP).
      // Reads its own caps from env; a safe no-op (ran:false) when the flag is
      // unset, so requesting it explicitly never surprises with Bedrock spend.
      case "rechunk-sweep":
        r = await runFenced(engine, p, () => rechunkSweepPhase(engine, {}), progress, signal);
        break;
      default:
        r = {
          phase: p,
          ok: false,
          status: "fail",
          durationMs: 0,
          error: `unknown phase: ${p as string}`,
        };
    }
    phases.push(r);
  }

  const finishedAt = new Date().toISOString();
  const partial = phasesNotRun.length > 0 || phases.some((p) => interruptedPhases.has(p));
  const ok = !partial && phases.every((p) => p.ok);
  const status: PhaseStatus = partial || phases.some((p) => p.status === "fail")
    ? "fail"
    : phases.some((p) => p.status === "warn")
      ? "warn"
      : "ok";
  const reason = partial ? cycleReasonOf(signal) : undefined;
  const orphanedPhase = phases.find((p) => p.orphaned)?.phase;
  progress({
    kind: ok ? "completed" : "failed",
    op: "cycle",
    result: { phases: phases.length, ok },
    error: ok ? undefined : reason ? `cycle stopped: ${reason}` : "one or more phases failed",
    ts: Date.now(),
  } as never);
  return {
    schemaVersion: CYCLE_REPORT_SCHEMA_VERSION,
    startedAt,
    finishedAt,
    outcome: partial ? "partial" : "complete",
    ...(reason ? { reason, phasesNotRun } : {}),
    phases,
    ...(orphanedPhase ? { orphanedPhase } : {}),
    ok,
    status,
  };
}
