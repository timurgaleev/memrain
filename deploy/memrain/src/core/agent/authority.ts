/**
 * The authority a tenant-submitted agent job runs under.
 *
 * At submit, the caller's grant is frozen into a snapshot stored on the job
 * row: which OAuth client, who it spends as, the grant revision, the sources
 * it reads, the tools it may call, and a hash of the payload. The worker never
 * trusts that snapshot on its own. At claim, and again before every model call
 * and every tool dispatch, `resolveLiveAuthority` re-reads the client row and
 * refuses the moment the grant no longer backs the snapshot: the client is
 * gone, its revision moved, it lost the `agent` scope or its daily cap, its
 * sources changed, or its bound tools no longer cover the job's tools.
 *
 * A snapshot that passes rebuilds the AuthInfo the job dispatches with, so
 * every per-tool scope and source gate in `dispatchTool` applies exactly as it
 * would to the tenant's own MCP call. The rebuilt identity never carries more
 * than the submitting token had: its scopes are the token's, narrowed to what
 * the client row still grants.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { effectiveReadSourceIds, type AuthInfo } from "../auth-info.ts";
import { hasScope, parseScopeString } from "../scope.ts";
import { isTrustTier } from "../trust-tier.ts";

export interface AgentAuthority {
  v: 1;
  clientId: string;
  /** The spend ledger key: the enrollment id for an enrolled person, else the client id. */
  spender: string;
  grantRevision: number;
  sourceId: string | null;
  /** The effective read set at submit; never empty (refused at submit). */
  readSourceIds: string[];
  /** Scopes the submitting token carried. */
  scopes: string[];
  /** The job's tool allowlist: the agent's read tools narrowed by `bound_tools`. */
  tools: string[];
  isPublic: boolean;
  payloadSha256: string;
}

/** The grant behind a tenant job no longer holds; the job must stop. */
export class AgentGrantRevoked extends Error {
  constructor(
    readonly clientId: string,
    readonly reason: string,
  ) {
    super(`agent: the grant for client ${clientId} no longer backs this job (${reason}); stopping`);
    this.name = "AgentGrantRevoked";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/**
 * SHA-256 of the payload with keys sorted: JSONB does not keep the key order
 * it was given, so the hash must not depend on it.
 */
export function payloadSha256(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload)), "utf8").digest("hex");
}

/** The tools a job may call: `allowlist` narrowed by `bound_tools` when the client sets it. */
export function intersectBoundTools(
  allowlist: readonly string[],
  boundTools: readonly string[] | null | undefined,
): string[] {
  if (boundTools === null || boundTools === undefined) return [...allowlist];
  const bound = new Set(boundTools);
  return allowlist.filter((t) => bound.has(t));
}

export function snapshotAuthority(
  auth: AuthInfo,
  input: {
    grantRevision: number;
    tools: readonly string[];
    payload: Record<string, unknown>;
  },
): AgentAuthority {
  const readSourceIds = effectiveReadSourceIds(auth);
  if (!readSourceIds || readSourceIds.length === 0) {
    throw new Error("agent: a tenant job needs a non-empty read grant");
  }
  return {
    v: 1,
    clientId: auth.clientId,
    spender: auth.spendId ?? auth.clientId,
    grantRevision: input.grantRevision,
    sourceId: auth.sourceId ?? null,
    readSourceIds: [...readSourceIds],
    scopes: [...auth.scopes],
    tools: [...input.tools],
    isPublic: auth.isPublic === true,
    payloadSha256: payloadSha256(input.payload),
  };
}

function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate a stored snapshot; a malformed one is refused, never repaired. */
export function parseAuthority(raw: unknown): AgentAuthority {
  const bad = (what: string): never => {
    throw new Error(`agent: job authority is malformed (${what})`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("not an object");
  const a = raw as Record<string, unknown>;
  if (a.v !== 1) bad("version");
  if (typeof a.clientId !== "string" || a.clientId.length === 0) bad("clientId");
  if (typeof a.spender !== "string" || a.spender.length === 0) bad("spender");
  if (typeof a.grantRevision !== "number" || !Number.isInteger(a.grantRevision)) bad("grantRevision");
  if (a.sourceId !== null && typeof a.sourceId !== "string") bad("sourceId");
  if (!stringArray(a.readSourceIds) || a.readSourceIds.length === 0) bad("readSourceIds");
  if (!stringArray(a.scopes)) bad("scopes");
  if (!stringArray(a.tools) || a.tools.length === 0) bad("tools");
  if (typeof a.isPublic !== "boolean") bad("isPublic");
  if (typeof a.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.payloadSha256)) bad("payloadSha256");
  return a as unknown as AgentAuthority;
}

interface ClientRow {
  client_id: string;
  scope: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  bound_tools: string[] | null;
  grant_revision: number | string;
  deleted_at: string | Date | null;
  budget_usd_per_day: string | number | null;
  min_trust: string | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * Re-check a snapshot against the live client row. Returns the AuthInfo the
 * job dispatches with, or throws AgentGrantRevoked naming the first reason.
 * `budgetUsdPerDay` is left unset so the spend chokepoint reads the live cap
 * on every paid call.
 */
export async function resolveLiveAuthority(
  engine: Engine,
  snap: AgentAuthority,
): Promise<AuthInfo> {
  const r = await engine.query<ClientRow>(
    `SELECT client_id, scope, source_id, federated_read, bound_tools, grant_revision,
            deleted_at, budget_usd_per_day, min_trust
       FROM oauth_clients WHERE client_id = $1`,
    [snap.clientId],
  );
  const row = r.rows[0];
  const refuse = (reason: string): never => {
    throw new AgentGrantRevoked(snap.clientId, reason);
  };
  if (!row || row.deleted_at != null) return refuse("client revoked");
  if (Number(row.grant_revision) !== snap.grantRevision) return refuse("grant changed");
  const rowScopes = parseScopeString(row.scope);
  if (!hasScope(rowScopes, "agent")) return refuse("agent scope withdrawn");
  if (row.budget_usd_per_day === null || !Number.isFinite(Number(row.budget_usd_per_day))) {
    return refuse("daily budget cleared");
  }
  if ((row.source_id ?? null) !== snap.sourceId) return refuse("write source changed");
  const allowedSources = Array.isArray(row.federated_read) ? row.federated_read : undefined;
  const liveRead = effectiveReadSourceIds({
    token: "",
    clientId: row.client_id,
    scopes: [],
    isPublic: snap.isPublic,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(allowedSources ? { allowedSources } : {}),
  });
  if (!liveRead || !sameSet(liveRead, snap.readSourceIds)) return refuse("read sources changed");
  if (row.bound_tools !== null && !snap.tools.every((t) => row.bound_tools!.includes(t))) {
    return refuse("bound tools narrowed");
  }
  const scopes = snap.scopes.filter((s) => hasScope(rowScopes, s));
  // A read floor set on the client after the job was queued holds for its
  // remaining tool calls; a value that names no tier stops the job.
  if (row.min_trust !== null && !isTrustTier(row.min_trust)) return refuse("read floor unreadable");
  return {
    token: "",
    clientId: snap.clientId,
    scopes,
    isPublic: snap.isPublic,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    allowedSources: [...snap.readSourceIds],
    ...(snap.spender !== snap.clientId ? { spendId: snap.spender } : {}),
    ...(isTrustTier(row.min_trust) ? { minTrust: row.min_trust } : {}),
  };
}
