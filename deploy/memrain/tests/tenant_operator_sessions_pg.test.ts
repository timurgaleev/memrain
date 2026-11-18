/**
 * The operator's commands never run SQL in a tenant database with more power
 * than the tenant has there. The tenant owns its database, so it can plant a
 * schema named after whoever connects (first on the default search_path), a
 * view in it that shadows `jobs`, `pages` or `members`, and a
 * function in that view that runs as the caller and can `RESET ROLE` or
 * `SET ROLE NONE` first. Run as the master, that function could grant one
 * tenant's owner role to another. Here it tries exactly that during suspend,
 * resume, usage, migrate, export and delete, and must get nowhere.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { runTenant } from "../src/commands/tenant.ts";
import { deleteTenant } from "../src/control/export.ts";
import { PG_URL, runSuffix } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(240_000);

describe.skipIf(!PG_URL)("operator sessions in a tenant database", () => {
  let fx: ControlFixture;
  let out: string;
  let attacker: string;
  let victim: string;
  const marker = `memrain_pwned_${runSuffix()}`;

  async function run(...args: string[]): Promise<number> {
    const log = console.log;
    console.log = () => undefined;
    try {
      return await runTenant(args, { MEMRAIN_CONTROL_ADMIN_URL: fx.masterUrl, MEMRAIN_TENANT_SECRETS_DIR: fx.secretsDir });
    } finally {
      console.log = log;
    }
  }

  /** What the planted function achieved: the victim's owner role granted to the attacker's, or a role only the master may create. */
  async function escalated(): Promise<{ granted: boolean; marker: boolean }> {
    const g = await fx.control.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE r.rolname = $1 AND u.rolname = $2`,
      [`tenant_${victim}_owner`, `tenant_${attacker}_owner`],
    );
    const k = await fx.control.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [marker]);
    return { granted: g.rows.length > 0, marker: k.rows.length > 0 };
  }

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    out = mkdtempSync(join(tmpdir(), "memrain-operator-sessions-"));
    attacker = fx.tenantId("mallory");
    victim = fx.tenantId("victim");
    await fx.create(attacker);
    await fx.create(victim);
    await plant(decodeURIComponent(new URL(fx.masterUrl).username));
  });

  /** As the attacker's own owner login, nothing it could not do from a compromised container: shadow tables in `schema`. */
  async function plant(schema: string): Promise<void> {
    const owner = `tenant_${attacker}_owner`;
    const brain = new PostgresEngine({ url: fx.secret(attacker, "postgres-url"), max: 1 });
    try {
      const s = `"${schema}"`;
      await brain.query(`CREATE SCHEMA ${s}`);
      await brain.query(`GRANT USAGE ON SCHEMA ${s} TO PUBLIC`);
      await brain.query(`
        CREATE FUNCTION ${s}.pwn() RETURNS boolean LANGUAGE plpgsql AS $f$
        BEGIN
          BEGIN
            EXECUTE 'RESET ROLE';
            EXECUTE format('GRANT %I TO %I', 'tenant_${victim}_owner', '${owner}');
          EXCEPTION WHEN others THEN NULL;
          END;
          BEGIN
            EXECUTE 'SET ROLE NONE';
            EXECUTE format('GRANT %I TO %I', 'tenant_${victim}_owner', '${owner}');
          EXCEPTION WHEN others THEN NULL;
          END;
          BEGIN
            EXECUTE 'RESET ROLE';
            EXECUTE format('CREATE ROLE %I', '${marker}');
          EXCEPTION WHEN others THEN NULL;
          END;
          RETURN true;
        END $f$`);
      for (const table of ["jobs", "pages", "members", "chat_threads"]) {
        await brain.query(`CREATE VIEW ${s}.${table} AS SELECT * FROM public.${table} WHERE ${s}.pwn()`);
        await brain.query(`GRANT SELECT ON ${s}.${table} TO PUBLIC`);
      }
    } finally {
      await brain.close();
    }
  }

  afterAll(async () => {
    await fx.control.query(`DROP ROLE IF EXISTS ${marker}`).catch(() => undefined);
    await fx.close();
    rmSync(out, { recursive: true, force: true });
  });

  it("migrate, suspend, resume, usage and export run with the tenant's own rights", async () => {
    // Migrations rebuild indexes, which a shadowing view would only break.
    expect(await run("migrate", attacker)).toBe(0);
    // A session that starts as the owner role finds a schema named after it.
    await plant(`tenant_${attacker}_owner`);
    expect(await run("suspend", attacker, "--mode", "block")).toBe(0);
    expect(await run("resume", attacker)).toBe(0);
    expect(await run("usage", attacker, "--date", new Date().toISOString().slice(0, 10))).toBe(0);
    expect(await run("export", attacker, "--out", join(out, "live"))).toBe(0);
    expect(await escalated()).toEqual({ granted: false, marker: false });
  });

  it("the export under the delete fence runs with the tenant's own rights too", async () => {
    await deleteTenant({ masterUrl: fx.masterUrl, control: fx.control }, attacker, attacker, join(out, "fenced"));
    expect(await escalated()).toEqual({ granted: false, marker: false });
  });

  it("leaves no temporary login behind", async () => {
    const r = await fx.control.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [`tenant_${attacker}_owner_%`]);
    expect(r.rows).toEqual([]);
  });
});
