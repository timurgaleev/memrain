/**
 * The operator's throwaway login into a tenant database is dropped even when
 * the tenant holds up its clean-up: an object pinned to the login stays
 * locked longer than a statement may normally run. The clean-up transaction
 * turns its own timeouts off, so it waits instead of failing and leaving the
 * login behind. Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch
 * Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { asTenantOwner } from "../src/control/tenant-session.ts";
import { PG_URL } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(180_000);

/** Longer than the engine's default statement timeout (30 s). */
const HOLD_MS = 33_000;

describe.skipIf(!PG_URL)("operator login clean-up", () => {
  let fx: ControlFixture;
  let id: string;

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    id = fx.tenantId("slow");
    await fx.create(id);
  });
  afterAll(async () => {
    await fx.close();
  });

  it("outwaits a tenant lock on an object pinned to the login", async () => {
    const tenant = new PostgresEngine({ url: fx.secret(id, "postgres-url"), max: 1, statementTimeoutMs: 120_000 });
    let held: Promise<void> = Promise.resolve();
    try {
      await tenant.query(`CREATE SCHEMA pinbox`);
      await tenant.query(`GRANT USAGE, CREATE ON SCHEMA pinbox TO PUBLIC`);
      await asTenantOwner(fx.masterUrl, id, async (brain) => {
        // What planted code could do: leave an object the login owns.
        await brain.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE NONE`);
          await tx.query(`CREATE TABLE pinbox.pin (x int)`);
          await tx.query(`GRANT ALL ON pinbox.pin TO PUBLIC`);
        });
        let locked!: () => void;
        const ready = new Promise<void>((r) => { locked = r; });
        held = tenant.transaction(async (tx) => {
          await tx.query(`LOCK TABLE pinbox.pin IN ACCESS EXCLUSIVE MODE`);
          locked();
          await tx.query(`SELECT pg_sleep($1::float8 / 1000)`, [HOLD_MS]);
        });
        await ready;
      });
      await held;
      const left = await fx.control.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [`tenant_${id}_owner_op_%`]);
      expect(left.rows).toEqual([]);
    } finally {
      await held.catch(() => undefined);
      await tenant.close();
    }
  });
});
