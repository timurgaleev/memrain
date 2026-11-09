/**
 * `submit_agent` / `get_agent_job`: a tenant hands the brain a read-only agent
 * task that runs under its own grant, and reads back only its own jobs.
 *
 * Submission fails closed at every gate: both agent flags on, a token caller
 * (the operator uses `memrain agent run`), the `agent` scope (only the operator
 * CLI can grant it; dynamic registration drops it), a token that speaks for
 * the client's own grant (an enrollment-bound session is refused), a non-empty
 * read grant, a finite daily budget, and at least one tool left after
 * `bound_tools`. The concurrency check runs under a row lock on the client, so
 * two racing submits cannot both see a free slot under `bound_max_concurrent`.
 */
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { effectiveReadSourceIds, type AuthInfo } from "../auth-info.ts";
import { hasScope, parseScopeString } from "../scope.ts";
import { OperationError, type OperationErrorCode } from "../operation-error.ts";
import { Queue } from "../jobs/queue.ts";
import {
  AGENT_JOB_TIMEOUT_MS,
  SUBAGENT_JOB_KIND,
  agentEnabled,
  agentTenantEnabled,
  parseSubagentPayload,
} from "./handler.ts";
import { AGENT_READ_TOOLS } from "./tools.ts";
import { intersectBoundTools, parseAuthority, snapshotAuthority, type AgentAuthority } from "./authority.ts";

/** Statuses that hold one of the client's concurrent slots. */
const ACTIVE_STATUSES = ["pending", "running"];

function refuse(code: OperationErrorCode, message: string, suggestion?: string): never {
  throw new OperationError(code, message, suggestion);
}

/** The gates that need no database: who is asking, and whether it is switched on. */
function assertTenantCaller(auth: AuthInfo | undefined, tool: string): AuthInfo {
  if (auth === undefined) {
    refuse(
      "unsupported",
      `${tool} runs an agent under a tenant's grant; the operator has no grant to run under`,
      "Use `memrain agent run` for an operator agent job.",
    );
  }
  if (!agentEnabled() || !agentTenantEnabled()) {
    refuse(
      "unsupported",
      "tenant agent jobs are not enabled on this brain",
      "The operator enables them with MEMRAIN_AGENT_ENABLED=1 and MEMRAIN_AGENT_TENANT_ENABLED=1.",
    );
  }
  if (!hasScope(auth.scopes ?? [], "agent")) {
    refuse("insufficient_scope", `${tool} requires the 'agent' scope`, "Ask the operator for a client granted 'agent'.");
  }
  return auth;
}

interface LockedClient {
  scope: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  bound_tools: string[] | null;
  bound_max_concurrent: number | string;
  grant_revision: number | string;
  budget_usd_per_day: string | number | null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

export interface SubmitAgentResult {
  job_id: string;
  status: string;
  max_usd: number;
  tools: string[];
}

export async function submitTenantAgent(
  storage: Storage,
  authInfo: AuthInfo | undefined,
  args: { task?: unknown; max_usd?: unknown },
): Promise<SubmitAgentResult> {
  const auth = assertTenantCaller(authInfo, "submit_agent");
  if (auth.spendId !== undefined) {
    refuse(
      "unsupported",
      "submit_agent is not available to an enrollment-bound session yet",
      "Use a client registered for you with `memrain auth register-client`.",
    );
  }
  const readSourceIds = effectiveReadSourceIds(auth);
  if (!readSourceIds || readSourceIds.length === 0) {
    refuse("permission_denied", "submit_agent needs a source grant to read from");
  }
  const payload: Record<string, unknown> = { task: args.task };
  if (args.max_usd !== undefined) payload.max_usd = args.max_usd;
  let parsed;
  try {
    parsed = parseSubagentPayload(payload);
  } catch (err) {
    refuse("invalid_params", err instanceof Error ? err.message : String(err));
  }
  const stored = { task: parsed.task, max_usd: parsed.maxUsd };

  return storage.engine().transaction(async (tx: Engine) => {
    const locked = await tx.query<LockedClient>(
      `SELECT scope, source_id, federated_read, bound_tools, bound_max_concurrent,
              grant_revision, budget_usd_per_day
         FROM oauth_clients
        WHERE client_id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [auth.clientId],
    );
    const row = locked.rows[0];
    if (!row) refuse("permission_denied", "submit_agent is available only to a registered OAuth client");
    if (!hasScope(parseScopeString(row.scope), "agent")) {
      refuse("insufficient_scope", "this client is not granted the 'agent' scope");
    }
    if (row.budget_usd_per_day === null || !Number.isFinite(Number(row.budget_usd_per_day))) {
      refuse(
        "permission_denied",
        "submit_agent needs a daily budget on the client",
        "The operator sets one with `memrain auth set-budget`.",
      );
    }
    // The token must speak for the client's own grant: a token bound to some
    // other grant (an enrollment) would be re-checked against the wrong row.
    const clientRead =
      effectiveReadSourceIds({
        token: "",
        clientId: auth.clientId,
        scopes: [],
        isPublic: auth.isPublic,
        ...(row.source_id ? { sourceId: row.source_id } : {}),
        ...(Array.isArray(row.federated_read) ? { allowedSources: row.federated_read } : {}),
      }) ?? [];
    if ((auth.sourceId ?? null) !== (row.source_id ?? null) || !sameList(readSourceIds, clientRead)) {
      refuse("unsupported", "this token's grant is not its client's grant; submit_agent is refused");
    }
    const tools = intersectBoundTools(AGENT_READ_TOOLS, row.bound_tools);
    if (tools.length === 0) refuse("permission_denied", "this client's bound tools leave the agent no tool to use");

    const maxConcurrent = Number(row.bound_max_concurrent);
    const active = await tx.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE submitted_by = $1 AND kind = $2 AND status = ANY($3::text[])`,
      [auth.clientId, SUBAGENT_JOB_KIND, ACTIVE_STATUSES],
    );
    if (Number(active.rows[0]?.n ?? 0) >= maxConcurrent) {
      refuse(
        "rate_limited",
        `this client already has ${maxConcurrent} agent job(s) pending or running`,
        "Wait for one to finish (get_agent_job), then submit again.",
      );
    }

    const authority = snapshotAuthority(auth, {
      grantRevision: Number(row.grant_revision),
      tools,
      payload: stored,
    });
    const job = await new Queue(tx).enqueue({
      kind: SUBAGENT_JOB_KIND,
      payload: stored,
      timeoutMs: AGENT_JOB_TIMEOUT_MS,
      // A failed tenant run is terminal: a revoked grant must not come back
      // as a retry.
      maxRetries: 0,
      submittedBy: auth.clientId,
      authority: authority as unknown as Record<string, unknown>,
    });
    return { job_id: job.id, status: job.status, max_usd: parsed.maxUsd, tools };
  });
}

export interface AgentJobView {
  job_id: string;
  status: string;
  stop_reason: string | null;
  final_text: string | null;
  cost_usd: number;
  turns: number | null;
  error: string | null;
}

const NOT_FOUND = "no agent job with that id belongs to this client";

/** Errors the tenant may read back verbatim: the ones memrain itself raises about the run. */
function tenantSafeError(lastError: string | null, status: string): string | null {
  if (status !== "failed" && status !== "cancelled") return null;
  if (lastError && (lastError.startsWith("agent: ") || lastError.startsWith("subagent: "))) {
    return lastError.slice(0, 500);
  }
  return status === "failed" ? "the agent run failed; the operator can see why with `memrain agent logs`" : null;
}

/** The job's snapshot, when the caller holds exactly the grant it ran under; else null. */
function snapshotForCaller(auth: AuthInfo, raw: unknown): AgentAuthority | null {
  // A person enrolled on a shared connector shares its clientId, not its grant.
  if (auth.spendId !== undefined) return null;
  let snap: AgentAuthority;
  try {
    snap = parseAuthority(raw);
  } catch {
    return null;
  }
  if (snap.clientId !== auth.clientId || snap.spender !== auth.clientId) return null;
  const read = effectiveReadSourceIds(auth);
  if (!read || !sameList(read, snap.readSourceIds)) return null;
  if ((auth.sourceId ?? null) !== snap.sourceId) return null;
  return snap;
}

const WITHHELD = "this client's grant changed after the job ran; its answer is withheld";

/**
 * A tenant's own agent job. Anything else — another client's job, an operator
 * job, a non-agent job, an id that does not exist, or a job that read sources
 * the caller does not hold now — gets the same not-found, so the answer never
 * says whether an id is taken. When the grant moved in a way the source set
 * does not show (a narrowed slug fence), the status stays readable but the
 * answer does not.
 */
export async function getAgentJobForOwner(
  storage: Storage,
  authInfo: AuthInfo | undefined,
  jobId: unknown,
): Promise<AgentJobView> {
  const auth = assertTenantCaller(authInfo, "get_agent_job");
  if (typeof jobId !== "string" || jobId.length === 0) {
    refuse("invalid_params", "get_agent_job: `job_id` is required");
  }
  const job = await new Queue(storage.engine()).get(jobId);
  if (!job || job.kind !== SUBAGENT_JOB_KIND || job.submittedBy === null || job.submittedBy !== auth.clientId) {
    refuse("not_found", NOT_FOUND);
  }
  const snap = snapshotForCaller(auth, job.authority);
  if (!snap) refuse("not_found", NOT_FOUND);
  const live = await storage.engine().query<{ grant_revision: number | string }>(
    "SELECT grant_revision FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL",
    [auth.clientId],
  );
  const liveRevision = live.rows[0]?.grant_revision;
  if (liveRevision === undefined) refuse("not_found", NOT_FOUND);
  const withheld = Number(liveRevision) !== snap.grantRevision;
  const result = job.result ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const finalText = str(result.final_text);
  return {
    job_id: job.id,
    status: job.status,
    stop_reason: str(result.stop_reason),
    final_text: withheld ? null : finalText,
    cost_usd: job.costUsd,
    turns: typeof result.turns === "number" ? result.turns : null,
    error: tenantSafeError(job.lastError, job.status) ?? (withheld && finalText !== null ? WITHHELD : null),
  };
}
