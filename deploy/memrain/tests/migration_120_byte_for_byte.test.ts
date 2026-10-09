/**
 * Migration 120 and its down leave a pre-rename brain byte-for-byte as it was:
 * the whole-database manifest (every table, sequence, function and trigger)
 * after up → down equals the one before up, and up → down → up equals the first
 * up except the migrations row's applied_at. A boot in maintenance mode between
 * up and down writes nothing either (the fixture carries an expired token, code
 * and consumed refresh row, which a boot token sweep would delete). Runs on
 * PGLite, and on Postgres with psql when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import type { loadConfig } from "../src/core/config.ts";
import { MAINTENANCE_ENV, resolveQuiescence } from "../src/core/quiescence.ts";
import { bootTokenSweep, startBackgroundWork, type BackgroundDeps } from "../src/commands/serve.ts";
import { setSpendLedgerEngine } from "../src/core/budget.ts";
import { changedKeys, ENGINES, migrateTo120, seedLegacy, type Db } from "./helpers/migration-120.ts";

for (const { name, open } of ENGINES) {
  describe(`migration 120 up → down is an identity (${name})`, () => {
    let db: Db;
    let base: string;

    beforeEach(async () => {
      db = await open();
      await seedLegacy(db.engine);
      base = await db.manifest();
    });
    afterEach(async () => {
      // Storage.init() below applies the fixture's MEMEX_A row to the env and
      // points the spend ledger at this database.
      delete process.env.MEMEX_A;
      delete process.env.MEMRAIN_A;
      setSpendLedgerEngine(null);
      await db.close();
    });

    it("up → down restores every line; up → down → up differs from the first up only in migrations", async () => {
      await migrateTo120(db.engine);
      const up1 = await db.manifest();
      expect(changedKeys(base, up1).length).toBe(4);
      await revertMigration(db.engine, 120);
      expect(await db.manifest()).toBe(base);
      await migrateTo120(db.engine);
      expect(changedKeys(up1, await db.manifest())).toEqual(["table\tmigrations"]);
    });

    it("up → down through the down file alone (psql -1 -f) restores every line", async () => {
      await migrateTo120(db.engine);
      await db.runDownFile();
      expect(await db.manifest()).toBe(base);
    });

    it("a boot in maintenance between up and down writes nothing", async () => {
      // Every shipped migration, 120 and the later ones (each with its own
      // down, reverted below before 120's), so the boot has none left to apply.
      await runMigrations(db.engine);
      const up = await db.manifest();

      const storage = new Storage(db.engine);
      await storage.init();
      const q = resolveQuiescence({ [MAINTENANCE_ENV]: "1" });
      const provider = new OAuthProvider({ engine: db.engine });
      const sweep = mock(() => provider.sweepExpiredTokens());
      await bootTokenSweep({ sweepExpiredTokens: sweep }, q);
      const deps = {
        registerSource: mock(async () => {}),
        sweepCodeRoots: mock(async () => ({ scanned: 0, reindexed: 0, skipped: 0, parseErrors: 0, errors: [], perRoot: [] })),
        startCycleLoop: mock(() => ({ stop: async () => {} })),
        startWorker: mock(() => {}),
        workerIntervalMs: 20,
      };
      const log = console.log;
      console.log = () => {};
      try {
        const { worker } = startBackgroundWork(
          storage,
          {} as ReturnType<typeof loadConfig>,
          q,
          deps as unknown as BackgroundDeps,
        );
        await new Promise((res) => setTimeout(res, 50));
        await worker.stop();
      } finally {
        console.log = log;
      }
      expect(sweep).not.toHaveBeenCalled();
      for (const fn of [deps.registerSource, deps.sweepCodeRoots, deps.startCycleLoop, deps.startWorker]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(await db.manifest()).toBe(up);

      await revertMigration(db.engine, 121);
      await revertMigration(db.engine, 120);
      expect(await db.manifest()).toBe(base);
    });

    it("control: the boot token sweep would change the fixture", async () => {
      await migrateTo120(db.engine);
      const up = await db.manifest();
      const err = console.error;
      console.error = () => {};
      try {
        await bootTokenSweep(new OAuthProvider({ engine: db.engine }), resolveQuiescence({}));
      } finally {
        console.error = err;
      }
      expect(changedKeys(up, await db.manifest())).toContain("table\toauth_tokens");
    });
  });
}
