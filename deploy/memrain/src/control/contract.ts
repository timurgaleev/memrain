/**
 * The hosting contract: what a brain needs to know when it runs as one tenant
 * of a hosted install, and the shapes the control plane hands around.
 *
 * Hosting mode is on when `MEMRAIN_TENANT_ID` or `MEMRAIN_CONTROL_URL` is set.
 * Either one alone still counts, so a half-configured tenant container fails
 * closed instead of running as an unguarded single-tenant brain. Off, every
 * function here returns a constant: no query, no `runtime_config` read, no
 * network call. Every hosting variable is environment-only (runtime-config.ts
 * ENV_ONLY_KEYS), so a stored row can never switch hosting on or off.
 */

export const HOSTING_ENV = {
  tenantId: "MEMRAIN_TENANT_ID",
  controlUrl: "MEMRAIN_CONTROL_URL",
  llmOff: "MEMRAIN_HOSTING_LLM_OFF",
  publicAuth: "MEMRAIN_PUBLIC_AUTH",
  app: "MEMRAIN_APP",
  requireMember: "MEMRAIN_REQUIRE_MEMBER",
} as const;

/**
 * The master-role URL of the control database, read only by the operator's
 * `memrain tenant` CLI. Never given to a tenant container.
 */
export const CONTROL_ADMIN_URL_ENV = "MEMRAIN_CONTROL_ADMIN_URL";

type Env = Readonly<Record<string, string | undefined>>;

/** A tenant id: also the suffix of its database and role names. */
export const TENANT_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

export type TenantStatus = "active" | "suspended" | "deleting";
export type TenantMode = "read-only" | "block";

export interface TenantLimits {
  maxMembers?: number;
  maxPages?: number;
  maxUsdPerDay?: number;
}

/** What this tenant may do right now, as the control plane states it. */
export interface TenantPolicy {
  status: TenantStatus;
  /** How a suspended tenant is held; null while active. */
  mode: TenantMode | null;
  limits: TenantLimits;
  /** Paid model calls are off for this tenant. */
  llmOff: boolean;
  /**
   * Whether the isolation smoke has passed for this container since it
   * started. The control-plane source always sets it; `unverified` serves
   * nothing but /health. Absent (a policy from another source) imposes nothing.
   */
  isolation?: "verified" | "unverified";
}

/** The policy of a brain that is not hosted: active, no limits, paid calls on. */
export const SINGLE_TENANT_POLICY: TenantPolicy = Object.freeze({
  status: "active",
  mode: null,
  limits: Object.freeze({}),
  llmOff: false,
});

export interface HostingMode {
  tenantId: string | null;
  controlUrl: string | null;
}

function envValue(env: Env, name: string): string | null {
  return env[name]?.trim() || null;
}

function envFlag(env: Env, name: string): boolean {
  const v = envValue(env, name)?.toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Null outside hosting mode. */
export function hostingMode(env: Env = process.env): HostingMode | null {
  const tenantId = envValue(env, HOSTING_ENV.tenantId);
  const controlUrl = envValue(env, HOSTING_ENV.controlUrl);
  if (tenantId === null && controlUrl === null) return null;
  return { tenantId, controlUrl };
}

export type PublicAuthMode = "oauth";

export interface HostingFlags {
  /** Local switch that turns every paid call off, on top of control's flag. */
  llmOff: boolean;
  /** `oauth`: no static public bearer; a missing credential gets 401, not 503. */
  publicAuth: PublicAuthMode | null;
  /** Serve the member app under /app. */
  app: boolean;
  /** Refuse a credential that is not bound to a member on /mcp and /ingest. */
  requireMember: boolean;
}

export function hostingFlags(env: Env = process.env): HostingFlags {
  const publicAuth = envValue(env, HOSTING_ENV.publicAuth);
  if (publicAuth !== null && publicAuth !== "oauth") {
    throw new Error(`${HOSTING_ENV.publicAuth} must be unset or 'oauth', got '${publicAuth}'`);
  }
  return {
    llmOff: envFlag(env, HOSTING_ENV.llmOff),
    publicAuth,
    app: envFlag(env, HOSTING_ENV.app),
    requireMember: envFlag(env, HOSTING_ENV.requireMember),
  };
}

/** Reads this tenant's policy from the control plane (and may cache it). */
export type TenantPolicySource = () => Promise<TenantPolicy>;

let policySource: TenantPolicySource | null = null;

/** Install the control-plane reader; null removes it. */
export function setTenantPolicySource(source: TenantPolicySource | null): void {
  policySource = source;
}

export function hasTenantPolicySource(): boolean {
  return policySource !== null;
}

/**
 * This tenant's policy. Outside hosting mode: {@link SINGLE_TENANT_POLICY},
 * without consulting anything. In hosting mode: the policy source's answer,
 * or null when there is no source or it failed. Null means unknown, and every
 * caller treats it fail-closed: reads pass, writes and paid calls do not.
 */
export async function tenantPolicy(env: Env = process.env): Promise<TenantPolicy | null> {
  if (hostingMode(env) === null) return SINGLE_TENANT_POLICY;
  if (policySource === null) return null;
  let policy: TenantPolicy;
  try {
    policy = await policySource();
  } catch {
    return null;
  }
  return envFlag(env, HOSTING_ENV.llmOff) ? { ...policy, llmOff: true } : policy;
}

/** A tenant's lifecycle state in the control plane. */
export type TenantLifecycleStatus = "provisioning" | TenantStatus | "deleted";

/** One row of `memrain tenant list --json`. */
export interface TenantListEntry {
  id: string;
  status: TenantLifecycleStatus;
  mode: TenantMode | null;
  hostname: string;
}

/** The whole `memrain tenant list --json` document. */
export interface TenantListJson {
  ok: true;
  tenants: TenantListEntry[];
}

export function renderTenantListJson(entries: readonly TenantListEntry[]): string {
  const tenants = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, status, mode, hostname }) => ({ id, status, mode, hostname }));
  const doc: TenantListJson = { ok: true, tenants };
  return JSON.stringify(doc);
}

/**
 * Where provisioning puts a tenant's generated secrets. Values are written,
 * never printed; a backend that cannot keep them private refuses.
 */
export interface SecretWriter {
  readonly backend: "file" | "aws";
  /** Store `value` under `<tenantId>/<name>`, replacing an older value. */
  put(tenantId: string, name: string, value: string): Promise<void>;
}
