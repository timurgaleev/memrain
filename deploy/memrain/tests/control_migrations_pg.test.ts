/**
 * The control plane's own migration set: applies to an empty database, applies
 * nothing the second time, and every down reverts its migration only while it
 * is the latest one and its guard holds. Skipped unless
 * MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { discoverMigrations } from "../src/core/migrate.ts";
import { CONTROL_MIGRATIONS_DIR, migrateControl, revertControl } from "../src/control/migrations.ts";
import { PG_URL, createScratchControl, type ScratchControl } from "./helpers/control-pg.ts";

describe.skipIf(!PG_URL)("control migrations on Postgres", () => {
  let control: ScratchControl;
  let e: PostgresEngine;

  beforeAll(async () => {
    control = await createScratchControl(PG_URL!);
    e = new PostgresEngine({ url: control.url, max: 2 });
  });
  afterAll(async () => {
    await e.close();
    await control.drop();
  });

  it("numbers its own set from 001 and applies it once", async () => {
    const ids = discoverMigrations(CONTROL_MIGRATIONS_DIR).map((m) => m.id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = await migrateControl(e);
    expect(first.applied.map((m) => m.id)).toEqual(ids);
    const second = await migrateControl(e);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(ids.length);
  });

  it("a down refuses unless its migration is the latest", async () => {
    await expect(revertControl(e, 3)).rejects.toThrow(/latest/);
  });

  it("001 down refuses while a tenant row exists", async () => {
    for (const id of [8, 7, 6, 5, 4, 3, 2]) await revertControl(e, id);
    await e.query(
      `INSERT INTO tenants (id, db_name, owner_role, ctl_role, hostname)
       VALUES ('acme', 'tenant_acme', 'tenant_acme_owner', 'tenant_acme_ctl', 'acme.example.test')`,
    );
    await expect(revertControl(e, 1)).rejects.toThrow(/tenants exist/);
    await e.query(`DELETE FROM tenants`);
    await revertControl(e, 1);
    const left = await e.query(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('tenants','tenant_events')`);
    expect(left.rows).toEqual([]);
    const again = await migrateControl(e);
    expect(again.applied.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("003 down refuses while a tenant role is still in the control group", async () => {
    const role = "memrain_ctl_probe_member";
    await e.query(`DROP ROLE IF EXISTS ${role}`);
    await e.query(`CREATE ROLE ${role} NOLOGIN IN ROLE memrain_tenant_ctl`);
    try {
      for (const id of [8, 7, 6, 5, 4]) await revertControl(e, id);
      await expect(revertControl(e, 3)).rejects.toThrow(/members/);
    } finally {
      await e.query(`DROP ROLE ${role}`);
    }
    await revertControl(e, 3);
    const fn = await e.query(`SELECT 1 FROM pg_proc WHERE proname = 'tenant_self'`);
    expect(fn.rows).toEqual([]);
    expect((await migrateControl(e)).applied.map((m) => m.id)).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
