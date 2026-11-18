/**
 * The control database's privilege matrix: every table and function of the
 * control plane against each tenant role and PUBLIC. A tenant's control login
 * may run three functions and nothing else, sees only its own row through
 * them, and cannot reach a tenant database; a tenant's database owner cannot
 * reach the control database at all. Skipped unless MEMRAIN_TEST_POSTGRES_URL
 * points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { PG_URL } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(120_000);

const TENANT_FUNCTIONS = ["tenant_self()", "hosting_reserve(numeric,integer)", "hosting_settle(uuid,numeric)"];

describe.skipIf(!PG_URL)("control privilege matrix", () => {
  let fx: ControlFixture;
  let a: string;
  let b: string;
  const probe = `memrain_probe_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    a = fx.tenantId("priv-a");
    b = fx.tenantId("priv-b");
    await fx.create(a);
    await fx.create(b);
    // A login with nothing granted stands in for PUBLIC.
    await fx.control.query(`CREATE ROLE ${probe} LOGIN`);
  });
  afterAll(async () => {
    await fx.control.query(`DROP ROLE IF EXISTS ${probe}`);
    await fx.close();
  });

  const roles = () => ({
    [`tenant_${a}_owner`]: "owner",
    [`tenant_${a}_ctl`]: "ctl",
    [`tenant_${b}_owner`]: "owner",
    [`tenant_${b}_ctl`]: "ctl",
    [probe]: "public",
  } as Record<string, "owner" | "ctl" | "public">);

  it("no tenant role or PUBLIC holds any privilege on any control table", async () => {
    const tables = (await fx.control.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    )).rows.map((r) => r.t);
    expect(tables).toEqual(expect.arrayContaining([
      "tenants", "tenant_events", "tenant_exports", "hosting_settings", "hosting_spend_windows",
      "tenant_spend_windows", "hosting_spend_reservations", "tenant_isolation", "migrations",
    ]));
    const granted: string[] = [];
    for (const role of Object.keys(roles())) {
      for (const t of tables) {
        const r = await fx.control.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ok`,
          [role, `public.${t}`],
        );
        if (r.rows[0]!.ok) granted.push(`${role}:${t}`);
      }
    }
    expect(granted).toEqual([]);
  });

  it("only control logins execute the tenant functions; nobody but the master runs hosting_expire", async () => {
    const fns = (await fx.control.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' ORDER BY 1`,
    )).rows.map((r) => r.sig);
    expect(fns.sort()).toEqual([...TENANT_FUNCTIONS, "hosting_expire(text)"].sort());
    for (const [role, kind] of Object.entries(roles())) {
      for (const fn of fns) {
        const r = await fx.control.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect({ role, fn, ok: r.rows[0]!.ok }).toEqual({ role, fn, ok: kind === "ctl" && TENANT_FUNCTIONS.includes(fn) });
      }
      const secdef = await fx.control.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'public' AND (NOT p.prosecdef OR p.proconfig IS NULL
                OR NOT ('search_path=pg_catalog, pg_temp' = ANY(p.proconfig)))`,
      );
      expect(secdef.rows[0]!.n).toBe(0);
    }
  });

  it("CONNECT on the control database belongs to control logins only", async () => {
    const db = new URL(fx.masterUrl).pathname.slice(1);
    for (const [role, kind] of Object.entries(roles())) {
      const r = await fx.control.query<{ ok: boolean }>(`SELECT has_database_privilege($1, $2, 'CONNECT') AS ok`, [role, db]);
      expect({ role, ok: r.rows[0]!.ok }).toEqual({ role, ok: kind === "ctl" });
    }
  });

  it("a control login sees only its own tenant, reads no table and writes no smoke stamp", async () => {
    const ctlA = new PostgresEngine({ url: fx.secret(a, "control-url"), max: 1 });
    try {
      const self = await ctlA.query<{ s: { id: string } }>(`SELECT tenant_self() AS s`);
      expect(self.rows[0]!.s.id).toBe(a);
      await expect(ctlA.query(`SELECT * FROM tenants`)).rejects.toThrow(/permission denied/);
      await expect(ctlA.query(`SELECT * FROM hosting_spend_windows`)).rejects.toThrow(/permission denied/);
      await expect(ctlA.query(
        `INSERT INTO tenant_isolation (tenant_id, container_started_at, boot_id, image_stamp) VALUES ($1, now(), 'b', 'i')`,
        [a],
      )).rejects.toThrow(/permission denied/);
      await expect(ctlA.query(`SELECT hosting_expire()`)).rejects.toThrow(/permission denied/);
    } finally {
      await ctlA.close();
    }
  });

  it("a control login cannot open a tenant database, and a database owner cannot open the control database", async () => {
    const ctl = new URL(fx.secret(a, "control-url"));
    ctl.pathname = `/tenant_${a}`;
    const owner = new URL(fx.secret(a, "postgres-url"));
    owner.pathname = new URL(fx.masterUrl).pathname;
    for (const url of [ctl, owner]) {
      const e = new PostgresEngine({ url: url.toString(), max: 1 });
      try {
        await expect(e.query("SELECT 1")).rejects.toThrow(/permission denied|CONNECT/i);
      } finally {
        await e.close();
      }
    }
  });
});
