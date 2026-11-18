/**
 * The control database as the operator's CLI sees it: tenant rows, their
 * lifecycle, limits and history. Every function here runs under the master
 * role; a tenant container never reaches these tables (it only has the
 * functions of control migration 003).
 */
import type { Engine } from "../core/engine/interface.ts";
import { TENANT_ID_RE, type TenantLimits, type TenantListEntry, type TenantMode } from "./contract.ts";

export type TenantRowStatus = "provisioning" | "active" | "suspended" | "deleting" | "deleted";
export type TenantPlan = "personal" | "team";

export interface TenantRow {
  id: string;
  status: TenantRowStatus;
  mode: TenantMode | null;
  dbName: string;
  ownerRole: string;
  ctlRole: string;
  hostname: string;
  plan: TenantPlan;
  limits: TenantLimits;
  ownerMember: string | null;
  connectorClientId: string | null;
  fenceId: string | null;
  deleteAfter: Date | null;
}

export class TenantError extends Error {
  constructor(
    readonly code:
      | "invalid_id"
      | "invalid_hostname"
      | "not_found"
      | "exists"
      | "retired"
      | "wrong_state"
      | "invalid_limits"
      | "no_receipt"
      | "window_open"
      | "isolation_failed",
    message: string,
  ) {
    super(message);
    this.name = "TenantError";
  }
}

/** Database and role names of tenant `id`. Only a validated id reaches here. */
export function tenantNames(id: string): { db: string; owner: string; ctl: string } {
  assertTenantId(id);
  const db = `tenant_${id}`;
  return { db, owner: `${db}_owner`, ctl: `${db}_ctl` };
}

export function assertTenantId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !TENANT_ID_RE.test(id)) {
    throw new TenantError("invalid_id", `tenant id must match ${TENANT_ID_RE.source}`);
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function assertHostname(host: unknown): asserts host is string {
  if (typeof host !== "string" || !HOSTNAME_RE.test(host)) {
    throw new TenantError("invalid_hostname", "hostname must be a lowercase DNS name such as acme.example.com");
  }
}

/** A SQL identifier, double-quoted. Callers pass only names built from a validated id. */
export function ident(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

/** A SQL string literal (for the few DDL statements that cannot take a bind). */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface RawTenant {
  id: string;
  status: TenantRowStatus;
  mode: TenantMode | null;
  db_name: string;
  owner_role: string;
  ctl_role: string;
  hostname: string;
  plan: TenantPlan;
  plan_limits: TenantLimits | string;
  owner_member: string | null;
  connector_client_id: string | null;
  fence_id: string | null;
  delete_after: Date | string | null;
}

function toRow(r: RawTenant): TenantRow {
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    dbName: r.db_name,
    ownerRole: r.owner_role,
    ctlRole: r.ctl_role,
    hostname: r.hostname,
    plan: r.plan,
    limits: typeof r.plan_limits === "string" ? (JSON.parse(r.plan_limits) as TenantLimits) : r.plan_limits,
    ownerMember: r.owner_member,
    connectorClientId: r.connector_client_id,
    fenceId: r.fence_id,
    deleteAfter: r.delete_after === null ? null : new Date(r.delete_after),
  };
}

export async function getTenant(control: Engine, id: string): Promise<TenantRow | null> {
  const r = await control.query<RawTenant>(`SELECT * FROM tenants WHERE id = $1`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export async function requireTenant(control: Engine, id: string): Promise<TenantRow> {
  assertTenantId(id);
  const t = await getTenant(control, id);
  if (!t) throw new TenantError("not_found", `no tenant '${id}'`);
  return t;
}

export async function listTenants(control: Engine, statuses?: readonly TenantRowStatus[]): Promise<TenantRow[]> {
  const r = statuses && statuses.length > 0
    ? await control.query<RawTenant>(`SELECT * FROM tenants WHERE status = ANY($1::text[]) ORDER BY id`, [statuses])
    : await control.query<RawTenant>(`SELECT * FROM tenants ORDER BY id`);
  return r.rows.map(toRow);
}

/** The `tenant list --json` row: `deleting` and `deleted` keep their names. */
export function listEntry(t: TenantRow): TenantListEntry {
  return { id: t.id, status: t.status, mode: t.mode, hostname: t.hostname };
}

export async function logTenantEvent(
  control: Pick<Engine, "query">,
  tenantId: string,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await control.query(`INSERT INTO tenant_events (tenant_id, kind, detail) VALUES ($1, $2, $3::text::jsonb)`, [
    tenantId,
    kind,
    JSON.stringify(detail),
  ]);
}

export async function tenantEvents(control: Engine, tenantId: string): Promise<{ kind: string; detail: Record<string, unknown> }[]> {
  const r = await control.query<{ kind: string; detail: Record<string, unknown> | string }>(
    `SELECT kind, detail FROM tenant_events WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  return r.rows.map((e) => ({ kind: e.kind, detail: typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail }));
}

/** Hold a tenant: `block` refuses everything but /health, `read-only` refuses every change. */
export async function suspendTenant(control: Engine, id: string, mode: TenantMode): Promise<TenantRow> {
  const t = await requireTenant(control, id);
  if (t.status !== "active" && t.status !== "suspended") {
    throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}; only an active or suspended tenant can be suspended`);
  }
  await control.transaction(async (tx) => {
    await tx.query(`UPDATE tenants SET status = 'suspended', mode = $2, updated_at = now() WHERE id = $1`, [id, mode]);
    await logTenantEvent(tx, id, "suspend", { mode });
  });
  return requireTenant(control, id);
}

export async function resumeTenant(control: Engine, id: string): Promise<TenantRow> {
  const t = await requireTenant(control, id);
  if (t.status !== "suspended") {
    throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}; only a suspended tenant can be resumed`);
  }
  await control.transaction(async (tx) => {
    await tx.query(`UPDATE tenants SET status = 'active', mode = NULL, updated_at = now() WHERE id = $1`, [id]);
    await logTenantEvent(tx, id, "resume");
  });
  return requireTenant(control, id);
}

const LIMIT_KEYS: Record<string, keyof TenantLimits> = {
  "max-members": "maxMembers",
  "maxmembers": "maxMembers",
  "max-pages": "maxPages",
  "maxpages": "maxPages",
  "max-usd-per-day": "maxUsdPerDay",
  "maxusdperday": "maxUsdPerDay",
};

/**
 * Parse `k=v` assignments into a limits patch. A value of `none` clears the
 * limit. Counts are whole numbers; the daily USD cap is a non-negative amount.
 */
export function parseLimitAssignments(pairs: readonly string[]): Partial<Record<keyof TenantLimits, number | null>> {
  const out: Partial<Record<keyof TenantLimits, number | null>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const rawKey = eq > 0 ? pair.slice(0, eq).trim().toLowerCase() : "";
    const key = LIMIT_KEYS[rawKey];
    if (!key) {
      throw new TenantError("invalid_limits", `unknown limit '${rawKey || pair}'; use max-members, max-pages or max-usd-per-day`);
    }
    const raw = pair.slice(eq + 1).trim();
    if (raw === "none") {
      out[key] = null;
      continue;
    }
    const n = Number(raw);
    const whole = key !== "maxUsdPerDay";
    if (raw === "" || !Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) {
      throw new TenantError("invalid_limits", `${rawKey} must be ${whole ? "a whole number" : "a non-negative amount"} or 'none'`);
    }
    out[key] = n;
  }
  return out;
}

export async function setTenantLimits(
  control: Engine,
  id: string,
  patch: Partial<Record<keyof TenantLimits, number | null>>,
): Promise<TenantRow> {
  const t = await requireTenant(control, id);
  const next: Record<string, number> = { ...(t.limits as Record<string, number>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  await control.transaction(async (tx) => {
    await tx.query(`UPDATE tenants SET plan_limits = $2::text::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(next)]);
    await logTenantEvent(tx, id, "limits", { limits: next });
  });
  return requireTenant(control, id);
}

/** Plan defaults, used at creation; the operator changes them with `tenant limits`. */
export const PLAN_LIMITS: Record<TenantPlan, TenantLimits> = {
  personal: { maxMembers: 1, maxPages: 20_000, maxUsdPerDay: 5 },
  team: { maxMembers: 25, maxPages: 100_000, maxUsdPerDay: 5 },
};
