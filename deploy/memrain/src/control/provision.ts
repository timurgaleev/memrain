/**
 * `memrain tenant create`: one hosted tenant brain from nothing to active.
 *
 * Each step is idempotent and leaves an event in `tenant_events`, so a run that
 * failed half-way is finished by running it again with `--resume`:
 *
 *   row         the `tenants` row, status `provisioning`
 *   roles       `tenant_<id>_owner` and `tenant_<id>_ctl`, with fresh passwords
 *   database    `tenant_<id>` owned by the owner role, closed to PUBLIC, with
 *               the extensions the brain needs (created by the master role)
 *   secrets     the database URL, the control URL and the tenant's own
 *               internal token, handed to the secret writer and never printed
 *   migrations  the brain's migrations, applied as the owner role
 *   connector   the tenant's one OAuth connector: a public enrollment-mode
 *               client (PKCE, no secret) for Claude.ai and ChatGPT
 *   owner       the owner's personal source and member
 *   invite      the owner's one-time invite link (needs member invites)
 *   postcheck   neither of this tenant's roles reaches another tenant's
 *               database or the reverse; then `active`
 *
 * Passwords are reset on every run, so a resumed run never needs a secret an
 * earlier run generated. SQL identifiers are built only from a validated id.
 * Being active does not let the container serve traffic yet: that waits for an
 * isolation smoke stamp (`tenant smoke-record`).
 */
import { randomBytes } from "node:crypto";
import type { Engine } from "../core/engine/interface.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { runMigrations } from "../core/migrate.ts";
import { OAuthProvider } from "../core/oauth-provider.ts";
import { registerSource } from "../core/sources.ts";
import { addMember, getMember } from "../core/members.ts";
import { MemberInviteError, memberInviteUrl, mintMemberInvite } from "../core/member-invites.ts";
import type { SecretWriter } from "./contract.ts";
import {
  PLAN_LIMITS,
  TenantError,
  assertHostname,
  getTenant,
  ident,
  literal,
  logTenantEvent,
  requireTenant,
  tenantEvents,
  tenantNames,
  type TenantPlan,
  type TenantRow,
} from "./tenants.ts";

export const PROVISION_STEPS = [
  "row", "roles", "database", "secrets", "migrations", "connector", "owner", "invite", "postcheck",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** The secrets a tenant container is started with. */
export const TENANT_SECRETS = {
  postgresUrl: "postgres-url",
  controlUrl: "control-url",
  internalToken: "internal-token",
} as const;

/** Callbacks of the clients the tenant connector serves (docs/TEAM-SETUP.md). */
export const CONNECTOR_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
] as const;

const DEFAULT_OWNER = "owner";
const INVITE_TTL_MS = 72 * 3_600_000;

/** Extensions the brain's migrations need, created by the master role. */
const EXTENSIONS = ["vector", "pg_trgm"] as const;

export interface ProvisionContext {
  /** Master-role URL of the control database (also reaches the server). */
  masterUrl: string;
  /** Master-role engine on the control database. */
  control: Engine;
  secrets: SecretWriter;
  /** Test seam: called before each step runs. */
  beforeStep?: (step: ProvisionStep) => void | Promise<void>;
  /** Test seam for the invite step; member invites by default. */
  mintInvite?: typeof mintMemberInvite;
}

export interface CreateTenantInput {
  id: string;
  hostname: string;
  plan?: TenantPlan;
  ownerMember?: string;
  /** Required to continue a tenant left in `provisioning`. */
  resume?: boolean;
}

export interface CreateTenantResult {
  id: string;
  status: TenantRow["status"];
  /** Steps this run carried out. */
  ran: ProvisionStep[];
  connectorClientId: string | null;
  /** Shown once; null when no invite was minted on this run. */
  invite: { url: string; expiresAt: string } | null;
  /** Why the tenant is not active yet. */
  pending: "invite" | null;
  alreadyActive?: true;
}

/** `url` pointing at database `db`. */
export function urlForDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** `url` logging in as `user`. */
export function urlForLogin(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

function controlDbName(masterUrl: string): string {
  const db = decodeURIComponent(new URL(masterUrl).pathname.replace(/^\//, ""));
  if (!db) throw new Error("the control URL names no database");
  return db;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

async function withEngine<T>(url: string, fn: (e: PostgresEngine) => Promise<T>): Promise<T> {
  const e = new PostgresEngine({ url, max: 2 });
  try {
    return await fn(e);
  } finally {
    await e.close();
  }
}

async function roleExists(e: Engine, role: string): Promise<boolean> {
  return (await e.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rows.length > 0;
}

export async function createTenant(ctx: ProvisionContext, input: CreateTenantInput): Promise<CreateTenantResult> {
  const names = tenantNames(input.id);
  assertHostname(input.hostname);
  const plan = input.plan ?? "personal";
  const owner = input.ownerMember ?? DEFAULT_OWNER;
  const id = input.id;
  const ran: ProvisionStep[] = [];
  const step = async (s: ProvisionStep, fn: () => Promise<void>): Promise<void> => {
    await ctx.beforeStep?.(s);
    await fn();
    ran.push(s);
    await logTenantEvent(ctx.control, id, `provision:${s}`);
  };

  const existing = await getTenant(ctx.control, id);
  if (existing) {
    if (existing.status === "deleting" || existing.status === "deleted") {
      throw new TenantError("retired", `tenant id '${id}' was deleted and is never reused`);
    }
    if (existing.status !== "provisioning") {
      return { id, status: existing.status, ran, connectorClientId: existing.connectorClientId, invite: null, pending: null, alreadyActive: true };
    }
    if (!input.resume) {
      throw new TenantError("exists", `tenant '${id}' is still provisioning; run the same command with --resume to finish it`);
    }
    if (existing.hostname !== input.hostname) {
      throw new TenantError("exists", `tenant '${id}' was created for host ${existing.hostname}`);
    }
  } else {
    await step("row", async () => {
      await ctx.control.query(
        `INSERT INTO tenants (id, db_name, owner_role, ctl_role, hostname, plan, plan_limits, owner_member)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)`,
        [id, names.db, names.owner, names.ctl, input.hostname, plan, JSON.stringify(PLAN_LIMITS[plan]), owner],
      );
    });
  }
  const row = await requireTenant(ctx.control, id);
  const ownerMember = row.ownerMember ?? owner;
  const ownerPassword = secret();
  const ctlPassword = secret();
  const controlDb = controlDbName(ctx.masterUrl);

  await step("roles", async () => {
    const c = ctx.control;
    for (const role of [names.owner, names.ctl]) {
      if (!(await roleExists(c, role))) await c.query(`CREATE ROLE ${ident(role)} LOGIN`);
      // Only a superuser may name the SUPERUSER attribute at all, even to
      // clear it, and the RDS master is not one: refuse such a role instead.
      const su = await c.query<{ su: boolean }>(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = $1`, [role]);
      if (su.rows[0]?.su) throw new TenantError("wrong_state", `role '${role}' is a superuser; a tenant role never is`);
    }
    await c.query(`ALTER ROLE ${ident(names.owner)} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD ${literal(ownerPassword)}`);
    await c.query(`ALTER ROLE ${ident(names.ctl)} WITH LOGIN NOCREATEDB NOCREATEROLE CONNECTION LIMIT 8 PASSWORD ${literal(ctlPassword)}`);
    await c.query(`ALTER ROLE ${ident(names.owner)} SET statement_timeout = '60s'`);
    await c.query(`ALTER ROLE ${ident(names.owner)} SET idle_in_transaction_session_timeout = '60s'`);
    await c.query(`ALTER ROLE ${ident(names.ctl)} SET statement_timeout = '5s'`);
    await c.query(`GRANT memrain_tenant_ctl TO ${ident(names.ctl)}`);
    await c.query(`GRANT CONNECT ON DATABASE ${ident(controlDb)} TO ${ident(names.ctl)}`);
    // A non-superuser master (RDS) may only create a database owned by a role
    // it can act as.
    await c.query(`GRANT ${ident(names.owner)} TO CURRENT_USER`);
  });

  await step("database", async () => {
    const c = ctx.control;
    const has = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [names.db]);
    if (has.rows.length === 0) await c.query(`CREATE DATABASE ${ident(names.db)} OWNER ${ident(names.owner)}`);
    await c.query(`REVOKE ALL ON DATABASE ${ident(names.db)} FROM PUBLIC`);
    await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${ident(names.db)} TO ${ident(names.owner)}`);
    await withEngine(urlForDatabase(ctx.masterUrl, names.db), async (e) => {
      for (const ext of EXTENSIONS) await e.query(`CREATE EXTENSION IF NOT EXISTS ${ident(ext)}`);
    });
  });

  const tenantDbUrl = urlForLogin(urlForDatabase(ctx.masterUrl, names.db), names.owner, ownerPassword);
  const tenantControlUrl = urlForLogin(ctx.masterUrl, names.ctl, ctlPassword);

  await step("secrets", async () => {
    await ctx.secrets.put(id, TENANT_SECRETS.postgresUrl, tenantDbUrl);
    await ctx.secrets.put(id, TENANT_SECRETS.controlUrl, tenantControlUrl);
    await ctx.secrets.put(id, TENANT_SECRETS.internalToken, secret());
  });

  let connectorClientId = row.connectorClientId;
  let invite: CreateTenantResult["invite"] = null;
  let pending: CreateTenantResult["pending"] = null;
  await withEngine(tenantDbUrl, async (brain) => {
    await step("migrations", async () => {
      await runMigrations(brain);
    });

    await step("connector", async () => {
      if (connectorClientId) return;
      const { clientId } = await new OAuthProvider({ engine: brain }).registerClientManual(
        `${id} connector`,
        ["authorization_code", "refresh_token"],
        "read write",
        [...CONNECTOR_REDIRECT_URIS],
        "default",
        undefined,
        "none",
        undefined,
        "enrollment",
      );
      await ctx.control.query(`UPDATE tenants SET connector_client_id = $2, updated_at = now() WHERE id = $1`, [id, clientId]);
      connectorClientId = clientId;
    });

    await step("owner", async () => {
      const source = `person-${ownerMember}`;
      const src = await brain.query(`SELECT 1 FROM sources WHERE id = $1`, [source]);
      if (src.rows.length === 0) {
        await registerSource(brain, { id: source, kind: "other", pathPrefix: `tenant:${source}` });
      }
      if (!(await getMember(brain, ownerMember))) {
        await addMember(brain, ownerMember, { personalSource: source, displayName: "Owner" }, { actor: "operator", via: "cli" });
      }
    });

    const invited = (await tenantEvents(ctx.control, id)).some((e) => e.kind === "provision:invite");
    if (!invited) {
      try {
        await step("invite", async () => {
          const minted = await (ctx.mintInvite ?? mintMemberInvite)(brain, ownerMember, INVITE_TTL_MS);
          invite = { url: memberInviteUrl(`https://${input.hostname}`, minted.token), expiresAt: minted.expiresAt.toISOString() };
        });
      } catch (err) {
        if (!(err instanceof MemberInviteError) || err.code !== "not_implemented") throw err;
        pending = "invite";
      }
    }
  });

  if (pending === null) {
    await step("postcheck", async () => {
      await assertIsolated(ctx.control, id, controlDb);
      await ctx.control.transaction(async (tx) => {
        await tx.query(`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'provisioning'`, [id]);
        await logTenantEvent(tx, id, "active");
      });
    });
  }
  const after = await requireTenant(ctx.control, id);
  return { id, status: after.status, ran, connectorClientId, invite, pending };
}

/**
 * Neither of `id`'s roles can connect to another tenant's database or to the
 * control database (the owner), and no other tenant's roles can connect to
 * `id`'s. Throws `isolation_failed` naming the first breach.
 */
export async function assertIsolated(control: Engine, id: string, controlDb: string): Promise<void> {
  const me = tenantNames(id);
  const others = (await control.query<{ id: string }>(
    `SELECT id FROM tenants WHERE id <> $1 AND status <> 'deleted'`, [id],
  )).rows.map((r) => tenantNames(r.id));
  const checks: [string, string][] = [
    [me.owner, controlDb],
    [me.ctl, me.db],
  ];
  for (const o of others) {
    checks.push([me.owner, o.db], [me.ctl, o.db], [o.owner, me.db], [o.ctl, me.db]);
  }
  for (const [role, db] of checks) {
    const r = await control.query<{ ok: boolean }>(
      `SELECT has_database_privilege($1, $2, 'CONNECT') AS ok
        WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
          AND EXISTS (SELECT 1 FROM pg_database WHERE datname = $2)`,
      [role, db],
    );
    if (r.rows[0]?.ok) throw new TenantError("isolation_failed", `role ${role} can connect to database ${db}`);
  }
}
