/**
 * Doctor self-heal / remediation layer.
 *
 * `memrain doctor` is a fast read-only probe by default. This module adds an
 * OPT-IN remediation layer on top of it:
 *
 *   - `classifyRemediation()` maps the doctor's ranked failures + structured
 *     health signals to concrete fix actions, each triaged as
 *     `remediable | human_only | blocked`.
 *   - `buildRemediationPlan()` is the read-only surface behind
 *     `memrain doctor --remediation-plan` — it never enqueues.
 *   - `autoFixDryViolations()` submits the safe, deterministic subset
 *     (re-embed a source with 0 embeddings, re-run a wedged cycle phase)
 *     as jobs on memrain's durable queue, honouring a per-run USD budget cap
 *     and a dry-run default.
 *   - `submitRemediation()` is the `--remediate` entry point: it plans, then
 *     hands the remediable actions to `autoFixDryViolations`.
 *
 * memrain has NO server-side subagent runtime — every fix is expressed as a row
 * on the durable jobs queue (`src/core/jobs`), picked up by the same worker
 * that runs the rest of the brain's background work. A `remediation` job's
 * handler (see `core/jobs/remediation-handlers.ts`) dispatches on
 * `payload.action`.
 *
 * Tenancy: every source-scoped fix pins its `source_id` in the job payload so
 * a remediation job can only ever touch the source it was minted for.
 */
import { createHash } from "node:crypto";
import type { Queue } from "./jobs/queue.ts";

import { REMEDIATION_JOB_KIND } from "./jobs/kinds.ts";

/** Job kind for every remediation fix enqueued by this layer. */
export { REMEDIATION_JOB_KIND };

/** Default per-run USD budget cap. Override with MEMRAIN_REMEDIATION_MAX_USD. */
export const DEFAULT_REMEDIATION_MAX_USD = 1.0;

/** Triage of a single fix. Only `remediable` actions are ever enqueued. */
export type RemediationStatus = "remediable" | "human_only" | "blocked";

/** Severity buckets — drive ordering (critical first) and operator UX. */
export type RemediationSeverity = "critical" | "high" | "medium" | "low";

/**
 * One structured fix derived from a doctor check.
 *
 *   id             — content-stable identifier for the UTC day. Reused as the
 *                    durable job id so a repeated `--remediate` the same day
 *                    is idempotent; a job that failed or was cancelled is
 *                    revived, and the next day mints a fresh id.
 *   check          — the originating doctor check name.
 *   status         — remediable | human_only | blocked.
 *   severity       — ordering + operator UX.
 *   action         — handler dispatch key (remediable only).
 *   payload        — passed verbatim to the job handler (remediable only).
 *   safe           — deterministic + side-effect-idempotent → auto-fixable.
 *   est_seconds    — upper-bound runtime estimate for budgeting.
 *   est_usd_cost   — USD estimate; summed against the per-run cap.
 *   rationale      — one-line "what this fixes" for human output.
 *   blocked_reason — populated when status === 'blocked'.
 *   human_hint     — populated when status === 'human_only'.
 */
export interface RemediationAction {
  id: string;
  check: string;
  status: RemediationStatus;
  severity: RemediationSeverity;
  action?: string;
  payload?: Record<string, unknown>;
  safe: boolean;
  est_seconds: number;
  est_usd_cost: number;
  rationale: string;
  blocked_reason?: string;
  human_hint?: string;
}

/** A doctor check reduced to the fields the classifier needs. */
export interface DoctorSignal {
  check: string;
  ok: boolean;
  detail?: string;
}

/** A source stuck at 0% embed coverage while it has embeddable chunks. */
export interface BrokenSource {
  source_id: string;
  embeddable_chunks: number;
}

/**
 * Everything the classifier needs, gathered by the doctor once so the pure
 * classifier never re-queries the DB.
 */
export interface RemediationInput {
  /** The doctor's checks (name + ok + detail). */
  signals: DoctorSignal[];
  /** Sources at 0% embed coverage with embeddable chunks (per-source probe). */
  brokenSources?: BrokenSource[];
  /** True when the maintenance cycle looks wedged / stale. */
  cycleStale?: boolean;
  /** Cycle phase to re-run for a stale cycle. Defaults to "embed-stale". */
  cyclePhase?: string;
  /** Clock for the action ids' UTC day (tests). Defaults to now. */
  now?: Date;
}

/** Read-only plan envelope behind `--remediation-plan`. */
export interface RemediationPlan {
  ok: boolean;
  actions: RemediationAction[];
  remediable: RemediationAction[];
  human_only: RemediationAction[];
  blocked: RemediationAction[];
  est_total_seconds: number;
  est_total_usd_cost: number;
}

/** Outcome of one enqueue attempt. */
export interface SubmittedAction {
  id: string;
  check: string;
  /** `revived`: a failed or cancelled job under the same id was reset to run again. */
  status: "submitted" | "revived" | "dry_run" | "skipped_budget" | "duplicate";
  est_usd_cost: number;
}

/** Report returned by autoFixDryViolations / submitRemediation. */
export interface AutoFixReport {
  dry_run: boolean;
  max_usd: number;
  submitted: SubmittedAction[];
  submitted_count: number;
  spent_usd: number;
}

const SEVERITY_RANK: Record<RemediationSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** SHA-256 → first 12 hex chars of a stable string. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Content-stable action id for one UTC day (also the durable job id). The day
 * keeps a fix that succeeded from blocking the same fix when it is needed
 * again tomorrow.
 */
function actionId(action: string, payload: Record<string, unknown>, now: Date): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const day = now.toISOString().slice(0, 10);
  return `remediation:${action}:${shortHash(`${action}:${canonical}`)}:${day}`;
}

/**
 * Read the per-run USD cap. Explicit `override` (CLI --max-usd) wins, then
 * MEMRAIN_REMEDIATION_MAX_USD, then the built-in default. Non-finite / negative
 * values fall through to the default (fail-safe, never uncapped).
 */
export function resolveMaxUsd(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const raw = process.env.MEMRAIN_REMEDIATION_MAX_USD?.trim();
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_REMEDIATION_MAX_USD;
}

/**
 * Pure classification: doctor signals → triaged fix actions.
 *
 * Design rules:
 *   - config / pglite / stats failures are HUMAN_ONLY — a broken config or a
 *     storage engine that won't open is not something a background job can fix,
 *     and every data-fix depends on the engine anyway.
 *   - When a root (config / pglite) is failing, source/cycle fixes are BLOCKED
 *     (the worker can't reach the DB to run them) rather than remediable.
 *   - A source stuck at 0% embed coverage → REMEDIABLE + safe (re-embed it).
 *   - A wedged / stale maintenance cycle → REMEDIABLE + safe (re-run the phase).
 *   - A failed job in the last 24h (source-health !ok) with no more specific
 *     signal → HUMAN_ONLY (needs `memrain jobs list --status failed` triage).
 */
export function classifyRemediation(input: RemediationInput): RemediationAction[] {
  const byName = new Map(input.signals.map((s) => [s.check, s]));
  const failing = (name: string): boolean => byName.get(name)?.ok === false;

  const rootFailing = failing("config") || failing("pglite");
  const now = input.now ?? new Date();
  const actions: RemediationAction[] = [];

  // Root causes — never auto-remediable.
  if (failing("config")) {
    actions.push({
      id: "remediation:human:config",
      check: "config",
      status: "human_only",
      severity: "critical",
      safe: false,
      est_seconds: 0,
      est_usd_cost: 0,
      rationale: "config missing or invalid",
      human_hint: "run 'memrain init --pglite' (or fix the config file), then re-run doctor",
    });
  }
  if (failing("pglite")) {
    actions.push({
      id: "remediation:human:pglite",
      check: "pglite",
      status: "human_only",
      severity: "critical",
      safe: false,
      est_seconds: 0,
      est_usd_cost: 0,
      rationale: "storage engine will not open",
      human_hint: "inspect the database path / connection; the brain cannot run until it opens",
    });
  }
  if (failing("stats")) {
    actions.push({
      id: "remediation:human:stats",
      check: "stats",
      status: rootFailing ? "blocked" : "human_only",
      severity: "high",
      safe: false,
      est_seconds: 0,
      est_usd_cost: 0,
      rationale: "schema stats query failed",
      ...(rootFailing
        ? { blocked_reason: "storage engine / config is failing — fix that first" }
        : { human_hint: "check migrations applied and the schema is intact" }),
    });
  }

  // source-health !ok == a failed job in the last 24h. No unambiguous single
  // fix, so it stays human_only unless the per-source probe pins a concrete
  // 0-coverage source (handled below as its own remediable action).
  if (failing("source-health")) {
    actions.push({
      id: "remediation:human:source-health",
      check: "source-health",
      status: rootFailing ? "blocked" : "human_only",
      severity: "high",
      safe: false,
      est_seconds: 0,
      est_usd_cost: 0,
      rationale: "a background job failed in the last 24h",
      ...(rootFailing
        ? { blocked_reason: "storage engine / config is failing — fix that first" }
        : { human_hint: "triage with 'memrain jobs list --status failed'" }),
    });
  }

  // Deterministic safe fix #1 — re-embed a source stuck at 0% coverage.
  for (const src of input.brokenSources ?? []) {
    if (src.embeddable_chunks <= 0) continue;
    const payload = { action: "reembed-source", source_id: src.source_id };
    const blocked = rootFailing;
    actions.push({
      id: actionId("reembed-source", { source_id: src.source_id }, now),
      check: "per-source-embed-coverage",
      status: blocked ? "blocked" : "remediable",
      severity: "high",
      action: "reembed-source",
      payload,
      safe: !blocked,
      est_seconds: Math.max(30, Math.ceil(src.embeddable_chunks / 10)),
      // Titan v2 embeddings are cheap; a small deterministic upper-bound so the
      // budget cap is meaningful without pretending to model token counts.
      est_usd_cost: Number((0.01 + src.embeddable_chunks * 0.00002).toFixed(4)),
      rationale: `source '${src.source_id}' has ${src.embeddable_chunks} embeddable chunk(s) at 0% coverage`,
      ...(blocked
        ? { blocked_reason: "storage engine / config is failing — fix that first" }
        : {}),
    });
  }

  // Deterministic safe fix #2 — re-run a wedged / stale maintenance cycle.
  if (input.cycleStale || failing("cycle-freshness")) {
    const phase = input.cyclePhase ?? "embed-stale";
    const payload = { action: "cycle-phase", phase };
    const blocked = rootFailing;
    actions.push({
      id: actionId("cycle-phase", { phase }, now),
      check: "cycle-freshness",
      status: blocked ? "blocked" : "remediable",
      severity: "medium",
      action: "cycle-phase",
      payload,
      safe: !blocked,
      est_seconds: 120,
      est_usd_cost: 0.05,
      rationale: `maintenance cycle looks stale — re-run the '${phase}' phase`,
      ...(blocked
        ? { blocked_reason: "storage engine / config is failing — fix that first" }
        : {}),
    });
  }

  return sortActions(actions);
}

/** Stable ordering: severity (critical first) then id. */
function sortActions(actions: RemediationAction[]): RemediationAction[] {
  return [...actions].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Read-only plan: classify + bucket + total the estimates. Never enqueues.
 */
export function buildRemediationPlan(input: RemediationInput): RemediationPlan {
  const actions = classifyRemediation(input);
  const remediable = actions.filter((a) => a.status === "remediable");
  const human_only = actions.filter((a) => a.status === "human_only");
  const blocked = actions.filter((a) => a.status === "blocked");
  return {
    ok: actions.length === 0,
    actions,
    remediable,
    human_only,
    blocked,
    est_total_seconds: remediable.reduce((s, a) => s + a.est_seconds, 0),
    est_total_usd_cost: Number(
      remediable.reduce((s, a) => s + a.est_usd_cost, 0).toFixed(4),
    ),
  };
}

export interface AutoFixOptions {
  /** Dry-run submits nothing (default TRUE — the safe default). */
  dryRun?: boolean;
  /** Per-run USD cap. Falls through resolveMaxUsd when undefined. */
  maxUsd?: number;
  /** Cap on the number of jobs enqueued in one run (default: no cap). */
  maxJobs?: number;
  /** Only enqueue actions flagged `safe` (default TRUE). */
  safeOnly?: boolean;
}

/**
 * Enqueue the deterministic-safe remediable actions as durable jobs.
 *
 * Honours:
 *   - dry-run DEFAULT (submits nothing unless dryRun === false),
 *   - a per-run USD budget cap (stops before the first action that would
 *     exceed it; later actions are skipped_budget),
 *   - a maxJobs cap,
 *   - idempotency (the action id is the job id → a repeat run the same day
 *     dedups; a pending, running or succeeded row reports `duplicate`, a
 *     failed or cancelled one is reset to run again and reports `revived`).
 *
 * Named `autoFixDryViolations` for the doctor's safe-autofix
 * surface: "dry" == the dry, deterministic fixes (no LLM judgement), and the
 * default is itself a dry-run.
 */
export async function autoFixDryViolations(
  queue: Queue,
  actions: RemediationAction[],
  opts: AutoFixOptions = {},
): Promise<AutoFixReport> {
  const dryRun = opts.dryRun !== false; // default TRUE
  const maxUsd = resolveMaxUsd(opts.maxUsd);
  const safeOnly = opts.safeOnly !== false; // default TRUE
  const maxJobs = opts.maxJobs ?? Number.POSITIVE_INFINITY;

  const candidates = sortActions(
    actions.filter(
      (a) => a.status === "remediable" && (!safeOnly || a.safe) && a.action,
    ),
  );

  const submitted: SubmittedAction[] = [];
  let spent = 0;
  let enqueued = 0;

  for (const a of candidates) {
    if (enqueued >= maxJobs) {
      submitted.push({ id: a.id, check: a.check, status: "skipped_budget", est_usd_cost: a.est_usd_cost });
      continue;
    }
    if (spent + a.est_usd_cost > maxUsd) {
      submitted.push({ id: a.id, check: a.check, status: "skipped_budget", est_usd_cost: a.est_usd_cost });
      continue;
    }
    if (dryRun) {
      submitted.push({ id: a.id, check: a.check, status: "dry_run", est_usd_cost: a.est_usd_cost });
      spent += a.est_usd_cost;
      enqueued++;
      continue;
    }
    const { outcome } = await queue.enqueueOrRevive({
      kind: REMEDIATION_JOB_KIND,
      id: a.id,
      payload: { ...(a.payload ?? {}), check: a.check },
      priority: a.severity === "critical" || a.severity === "high" ? 3 : 5,
    });
    const status: SubmittedAction["status"] =
      outcome === "created" ? "submitted" : outcome === "revived" ? "revived" : "duplicate";
    submitted.push({ id: a.id, check: a.check, status, est_usd_cost: a.est_usd_cost });
    if (status !== "duplicate") {
      spent += a.est_usd_cost;
      enqueued++;
    }
  }

  return {
    dry_run: dryRun,
    max_usd: maxUsd,
    submitted,
    submitted_count: submitted.filter(
      (s) => s.status === "submitted" || s.status === "revived" || s.status === "dry_run",
    ).length,
    spent_usd: Number(spent.toFixed(4)),
  };
}

/**
 * `--remediate` entry point: build the plan, then enqueue the safe remediable
 * subset via autoFixDryViolations. Dry-run by default.
 */
export async function submitRemediation(
  queue: Queue,
  input: RemediationInput,
  opts: AutoFixOptions = {},
): Promise<{ plan: RemediationPlan; report: AutoFixReport }> {
  const plan = buildRemediationPlan(input);
  const report = await autoFixDryViolations(queue, plan.remediable, opts);
  return { plan, report };
}
