/**
 * The control plane run by a master that is not a superuser, as on RDS: the
 * master holds CREATEROLE and CREATEDB and nothing more. Since PostgreSQL 16 a
 * CREATEROLE creator holds only ADMIN on the roles it makes, without the
 * privileges of those roles, so every step that acts as a tenant role must
 * first take them. A tenant is provisioned, scheduled for deletion and purged
 * end to end under that master.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { migrateControl } from "../src/control/migrations.ts";
import { FileSecretWriter } from "../src/control/secret-writer.ts";
import { createTenant, type ProvisionContext } from "../src/control/provision.ts";
import { deleteTenant, purgeDeleted } from "../src/control/export.ts";
import { requireTenant } from "../src/control/tenants.ts";
import { PG_URL, dropTenantArtifacts, runSuffix, withDatabase, withLogin } from "./helpers/control-pg.ts";
import { stubInvite } from "./helpers/control-tenants.ts";

setDefaultTimeout(240_000);

describe.skipIf(!PG_URL)("hosting control plane under a non-superuser master", () => {
  const suffix = runSuffix();
  const master = `memrain_master_${suffix}`;
  const controlDb = `memrain_control_n${suffix}`;
  const id = `nonsuper-${suffix}`;
  let su: PostgresEngine;
  let control: PostgresEngine;
  let masterUrl: string;
  let dir: string;
  let addedVector = false;

  beforeAll(async () => {
    su = new PostgresEngine({ url: PG_URL!, max: 1 });
    const password = randomBytes(18).toString("hex");
    await su.query(`CREATE ROLE ${master} LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD '${password}'`);
    await su.query(`CREATE DATABASE ${controlDb} OWNER ${master}`);
    // `vector` is not a trusted extension: on RDS the master's rds_superuser
    // membership may create it, here template1 carries it into new databases.
    const tpl = new PostgresEngine({ url: withDatabase(PG_URL!, "template1"), max: 1 });
    try {
      const has = await tpl.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
      if (has.rows.length === 0) {
        await tpl.query(`CREATE EXTENSION vector`);
        addedVector = true;
      }
    } finally {
      await tpl.close();
    }
    // The group role is cluster-wide: on a fresh RDS the master creates it,
    // here an earlier run may have, so the master gets what its creator holds.
    const group = await su.query(`SELECT 1 FROM pg_roles WHERE rolname = 'memrain_tenant_ctl'`);
    if (group.rows.length > 0) await su.query(`GRANT memrain_tenant_ctl TO ${master} WITH ADMIN OPTION`);
    masterUrl = withLogin(withDatabase(PG_URL!, controlDb), master, password);
    control = new PostgresEngine({ url: masterUrl, max: 4 });
    dir = mkdtempSync(join(tmpdir(), "memrain-nonsuper-"));
  });

  afterAll(async () => {
    await control?.close();
    await dropTenantArtifacts(PG_URL!, id);
    await su.query(`DROP DATABASE IF EXISTS ${controlDb} WITH (FORCE)`);
    await su.query(`DROP OWNED BY ${master}`).catch(() => undefined);
    await su.query(`DROP ROLE IF EXISTS ${master}`).catch(() => undefined);
    await su.close();
    if (addedVector) {
      const tpl = new PostgresEngine({ url: withDatabase(PG_URL!, "template1"), max: 1 });
      try {
        await tpl.query(`DROP EXTENSION IF EXISTS vector`);
      } finally {
        await tpl.close();
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("the master is not a superuser", async () => {
    const r = await control.query<{ su: boolean }>(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]!.su).toBe(false);
  });

  it("provisions, deletes behind the fence and purges a tenant", async () => {
    await migrateControl(control);
    const ctx: ProvisionContext = { masterUrl, control, secrets: new FileSecretWriter(join(dir, "secrets")), mintInvite: stubInvite };
    await createTenant(ctx, { id, hostname: `${id}.example.test` });
    expect((await requireTenant(control, id)).status).toBe("active");
    await deleteTenant({ masterUrl, control }, id, id, join(dir, "export"));
    const r = await purgeDeleted({ masterUrl, control }, { now: new Date(Date.now() + 8 * 86_400_000) });
    expect(r).toEqual({ purged: [id], skipped: [], removedExports: { [id]: [join(dir, "export")] }, finished: [id] });
    const roles = await su.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [`tenant_${id}%`]);
    expect(roles.rows).toEqual([]);
    const db = await su.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [`tenant_${id}`]);
    expect(db.rows).toEqual([]);
  });
});
