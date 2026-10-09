/**
 * Pre-rename lock rows are left alone: migration 120 and its down delete none
 * (the manifest's cycle_locks and worker_lock lines never change), a stale
 * `memex-cycle` row survives a new cycle lock and the reaper, and a live one
 * makes `status --quiescent` fail. Runs on PGLite, and on Postgres when
 * MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { revertMigration } from "../src/core/migrate.ts";
import { CYCLE_LOCK_ID, reapDeadHolderLocks, tryAcquireDbLock } from "../src/core/db-lock.ts";
import { quiescentFailures, readQuiescence } from "../src/commands/status.ts";
import { MAINTENANCE_ENV } from "../src/core/quiescence.ts";
import { ENGINES, migrateTo120, seedLegacy, type Db } from "./helpers/migration-120.ts";

const lockLines = (out: string) =>
  out.split("\n").filter((l) => /^table\t(?:cycle_locks|worker_lock)\t/.test(l));

for (const { name, open } of ENGINES) {
  describe(`legacy lock rows (${name})`, () => {
    let db: Db;

    beforeAll(async () => {
      db = await open();
      await seedLegacy(db.engine);
    });
    afterAll(async () => {
      await db.close();
    });

    it("migration 120 and its down delete no lock row", async () => {
      const before = lockLines(await db.manifest());
      expect(before.length).toBe(2);
      await migrateTo120(db.engine);
      expect(lockLines(await db.manifest())).toEqual(before);
      await revertMigration(db.engine, 120);
      expect(lockLines(await db.manifest())).toEqual(before);
      await migrateTo120(db.engine);
    });

    it("a stale memex-cycle row survives a new cycle lock and the reaper", async () => {
      const host = hostname();
      await db.engine.query(
        `INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
         VALUES ('memex-cycle:stale', 77, $1, NOW() - interval '2 hours', NOW() - interval '1 hour')`,
        [host],
      );
      const handle = await tryAcquireDbLock(db.engine, CYCLE_LOCK_ID);
      expect(handle).not.toBeNull();
      await reapDeadHolderLocks(db.engine, {
        processKill: () => {
          const e = new Error("no such process") as NodeJS.ErrnoException;
          e.code = "ESRCH";
          throw e;
        },
      });
      await handle!.release();
      const ids = await db.engine.query<{ id: string }>(`SELECT id FROM cycle_locks ORDER BY id`);
      expect(ids.rows.map((r) => r.id)).toEqual(["memex-cycle", "memex-cycle:embed", "memex-cycle:stale"]);
    });

    it("a live legacy cycle or worker row makes --quiescent fail; expired ones do not", async () => {
      const env = { [MAINTENANCE_ENV]: "1" };
      const s = await readQuiescence(db.engine, env);
      expect(s.live_cycle_locks).toBe(1);
      expect(s.live_worker_lock).toBe(1);
      expect(quiescentFailures(s)).toEqual(["live_cycle_locks=1", "live_worker_lock=1"]);
      await db.engine.exec(`
        UPDATE cycle_locks SET ttl_expires_at = NOW() - interval '1 minute' WHERE id = 'memex-cycle';
        UPDATE worker_lock SET heartbeat_at = NOW() - interval '1 hour' WHERE id = 'memex-jobs-worker';
      `);
      expect(quiescentFailures(await readQuiescence(db.engine, env))).toEqual([]);
    });
  });
}
