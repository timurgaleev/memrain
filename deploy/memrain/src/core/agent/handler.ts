/**
 * The `subagent` job handler: validates the payload, caps the spend and runs
 * the agent loop for one job.
 *
 * Registered by serve only when MEMRAIN_AGENT_ENABLED=1. The kind is not a
 * built-in, so with the flag off a submit is refused outright rather than
 * queued for a worker that will never run it.
 *
 * A row that carries a submitter and an authority snapshot is a tenant job
 * (`submit_agent`). It runs only while MEMRAIN_AGENT_TENANT_ENABLED=1, only if
 * its payload still hashes to what was submitted, and only as long as the
 * live grant backs the snapshot: every Converse call is booked to the
 * tenant's spender against its live daily cap, and every tool is dispatched
 * as the tenant. Operator rows run exactly as before.
 */
import type { Storage } from "../storage.ts";
import type { JobHandler } from "../jobs/types.ts";
import { registerHandler } from "../jobs/handlers.ts";
import { SUBAGENT_JOB_KIND } from "../jobs/kinds.ts";
import { runWithSpendClient } from "../budget.ts";
import { runAgent, type RunAgentOptions } from "./runner.ts";
import { parseAuthority, payloadSha256, resolveLiveAuthority } from "./authority.ts";

export { SUBAGENT_JOB_KIND };

export const DEFAULT_AGENT_MAX_USD = 0.25;
/** Longest task accepted, in UTF-8 bytes. */
export const MAX_AGENT_TASK_BYTES = 8 * 1024;
/** Wall clock a `subagent` job is enqueued with; the claim lock is extended to cover it. */
export const AGENT_JOB_TIMEOUT_MS = 600_000;

export function agentEnabled(raw: string | undefined = process.env.MEMRAIN_AGENT_ENABLED): boolean {
  return raw === "1";
}

/** Tenant-submitted agent jobs are a second opt-in on top of MEMRAIN_AGENT_ENABLED. */
export function agentTenantEnabled(
  raw: string | undefined = process.env.MEMRAIN_AGENT_TENANT_ENABLED,
): boolean {
  return raw === "1";
}

/** Per-job ceiling from MEMRAIN_AGENT_MAX_USD; anything but a positive number is the default. */
export function agentMaxUsd(raw: string | undefined = process.env.MEMRAIN_AGENT_MAX_USD): number {
  const trimmed = raw?.trim() ?? "";
  const n = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGENT_MAX_USD;
}

export interface SubagentPayload {
  task: string;
  maxUsd: number;
}

/**
 * Validate a `subagent` payload. A job may ask for less than the operator's
 * ceiling, never more: `max_usd` is clamped to MEMRAIN_AGENT_MAX_USD.
 */
export function parseSubagentPayload(
  payload: Record<string, unknown>,
  ceilingUsd: number = agentMaxUsd(),
): SubagentPayload {
  const task = payload.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new Error("subagent: payload.task must be a non-empty string");
  }
  if (Buffer.byteLength(task, "utf8") > MAX_AGENT_TASK_BYTES) {
    throw new Error(`subagent: payload.task exceeds ${MAX_AGENT_TASK_BYTES} bytes`);
  }
  let maxUsd = ceilingUsd;
  if (payload.max_usd !== undefined) {
    const v = payload.max_usd;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error("subagent: payload.max_usd must be a positive number");
    }
    maxUsd = Math.min(v, ceilingUsd);
  }
  return { task, maxUsd };
}

export type SubagentDeps = Pick<
  RunAgentOptions,
  "converse" | "dispatch" | "modelId" | "maxTurns" | "maxTokens"
>;

export function makeSubagentHandler(storage: Storage, deps: SubagentDeps = {}): JobHandler {
  return async (payload, ctx) => {
    // The worker extends the claim lock only to cover a timeout. Without one
    // (a bare `jobs_submit`), a long loop outlives its lock, the stall sweep
    // requeues it, and two attempts run the same job.
    if (!ctx.job.timeoutMs || ctx.job.timeoutMs <= 0) {
      throw new Error(
        `subagent: job has no timeout; submit it with timeout_ms (the CLI uses ${AGENT_JOB_TIMEOUT_MS})`,
      );
    }
    if (ctx.job.submittedBy !== null || ctx.job.authority !== null) {
      return runTenantJob(storage, deps, payload, ctx);
    }
    const { task, maxUsd } = parseSubagentPayload(payload);
    const result = await runAgent({
      storage,
      job: ctx.job,
      task,
      maxUsd,
      ...(ctx.recordUsage ? { recordUsage: ctx.recordUsage } : {}),
      ...(ctx.updateProgress ? { updateProgress: ctx.updateProgress } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...deps,
    });
    return { ...result };
  };
}

async function runTenantJob(
  storage: Storage,
  deps: SubagentDeps,
  payload: Record<string, unknown>,
  ctx: Parameters<JobHandler>[1],
): Promise<Record<string, unknown>> {
  if (!agentTenantEnabled()) {
    throw new Error("subagent: tenant agent jobs are off; set MEMRAIN_AGENT_TENANT_ENABLED=1 to run them");
  }
  const snap = parseAuthority(ctx.job.authority);
  if (ctx.job.submittedBy !== snap.clientId) {
    throw new Error("subagent: job submitter does not match its authority");
  }
  if (payloadSha256(payload) !== snap.payloadSha256) {
    throw new Error("subagent: job payload does not match the hash recorded at submit");
  }
  const { task, maxUsd } = parseSubagentPayload(payload);
  const engine = storage.engine();
  const authorize = () => resolveLiveAuthority(engine, snap);
  // Checked at claim, before the ledger gets its first row.
  await authorize();
  // No capUsd: the chokepoint reads the spender's live cap on every call, so
  // a lowered or spent budget stops the next call rather than the next run.
  const result = await runWithSpendClient({ clientId: snap.spender }, () =>
    runAgent({
      storage,
      job: ctx.job,
      task,
      maxUsd,
      tools: snap.tools,
      authorize,
      ...(ctx.recordUsage ? { recordUsage: ctx.recordUsage } : {}),
      ...(ctx.updateProgress ? { updateProgress: ctx.updateProgress } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...deps,
    }),
  );
  return { ...result };
}

export function registerSubagentHandler(storage: Storage, deps: SubagentDeps = {}): void {
  registerHandler(SUBAGENT_JOB_KIND, makeSubagentHandler(storage, deps));
}

/** Register the handler when MEMRAIN_AGENT_ENABLED=1; true when it did. */
export function registerSubagentHandlerIfEnabled(
  storage: Storage,
  raw: string | undefined = process.env.MEMRAIN_AGENT_ENABLED,
): boolean {
  if (!agentEnabled(raw)) return false;
  registerSubagentHandler(storage);
  return true;
}
