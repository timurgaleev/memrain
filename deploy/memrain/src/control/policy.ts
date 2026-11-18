/**
 * A tenant container's view of the control plane: one small connection pool
 * under the tenant's own control login (`MEMRAIN_CONTROL_URL`), on which it can
 * run only the functions of control migration 003.
 *
 * The policy is `tenant_self()`, cached for 30 s. When the control plane does
 * not answer, the last good policy stays in force; with none ever read the
 * policy is unknown, which every gate treats fail-closed (reads pass, writes
 * and paid calls do not).
 *
 * The isolation stamp is judged here, against this container: it counts only
 * when it was taken after the container started, on the same host boot and
 * the same image. Anything else is `unverified`, and the request gate then
 * serves nothing but /health.
 */
import { readFileSync } from "node:fs";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { resolveVersion } from "../version.ts";
import {
  hasTenantPolicySource,
  hostingMode,
  setTenantPolicySource,
  tenantPolicy,
  type TenantLimits,
  type TenantMode,
  type TenantPolicy,
  type TenantPolicySource,
  type TenantStatus,
} from "./contract.ts";

/** What `tenant_self()` returns. */
export interface TenantSelf {
  id: string;
  status: TenantStatus;
  mode: TenantMode | null;
  limits: TenantLimits;
  llm_off: boolean;
  isolation?: { boot_id: string; image_stamp: string; passed_at: string } | null;
}

export interface ContainerIdentity {
  startedAt: Date;
  /** The host kernel's boot id; null where there is none to read. */
  bootId: string | null;
  imageStamp: string;
}

export const POLICY_TTL_MS = 30_000;

const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function containerIdentity(): ContainerIdentity {
  return { startedAt: PROCESS_STARTED_AT, bootId: readBootId(), imageStamp: resolveVersion() };
}

export function isolationOf(s: TenantSelf, me: ContainerIdentity): "verified" | "unverified" {
  const stamp = s.isolation;
  if (!stamp || me.bootId === null) return "unverified";
  const passed = new Date(stamp.passed_at).getTime();
  const ok = stamp.boot_id === me.bootId
    && stamp.image_stamp === me.imageStamp
    && Number.isFinite(passed)
    && passed > me.startedAt.getTime();
  return ok ? "verified" : "unverified";
}

export interface ControlPolicyOptions {
  readSelf: () => Promise<TenantSelf | null>;
  identity?: () => ContainerIdentity;
  ttlMs?: number;
  now?: () => number;
}

export function controlPolicySource(opts: ControlPolicyOptions): TenantPolicySource {
  const ttl = opts.ttlMs ?? POLICY_TTL_MS;
  const now = opts.now ?? Date.now;
  const identity = opts.identity ?? containerIdentity;
  let cached: { policy: TenantPolicy; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttl) return cached.policy;
    try {
      const s = await opts.readSelf();
      if (!s) throw new Error("the control plane knows no tenant for this login");
      const policy: TenantPolicy = {
        status: s.status,
        mode: s.mode,
        limits: s.limits ?? {},
        llmOff: s.llm_off === true,
        isolation: isolationOf(s, identity()),
      };
      cached = { policy, at: now() };
      return policy;
    } catch (err) {
      if (cached) return cached.policy;
      throw err;
    }
  };
}

let client: PostgresEngine | null = null;

function isPostgresUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "postgres:" || u.protocol === "postgresql:";
  } catch {
    return false;
  }
}

/** The control connection of this container, or null outside hosting or without a usable URL. */
export function controlClient(env: NodeJS.ProcessEnv = process.env): PostgresEngine | null {
  const url = hostingMode(env)?.controlUrl;
  if (!url || !isPostgresUrl(url)) return null;
  client ??= new PostgresEngine({ url, max: 2, statementTimeoutMs: 5_000, applicationName: "memrain:control" });
  return client;
}

/** Drop the control connection (tests, and a process that is shutting down). */
export function resetControlClient(): void {
  const c = client;
  client = null;
  void c?.close().catch(() => undefined);
}

/**
 * In hosting mode, install the control-backed policy source unless one is
 * installed already. True when a source is in place afterwards.
 */
export function ensureControlPolicySource(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasTenantPolicySource()) return true;
  const c = controlClient(env);
  if (!c) return false;
  setTenantPolicySource(controlPolicySource({
    readSelf: async () => (await c.query<{ s: TenantSelf | null }>(`SELECT tenant_self() AS s`)).rows[0]?.s ?? null,
  }));
  return true;
}

/** This tenant's policy, from the control plane when hosted (see contract.tenantPolicy). */
export async function hostedPolicy(): Promise<TenantPolicy | null> {
  if (hostingMode() !== null) ensureControlPolicySource();
  return tenantPolicy();
}
