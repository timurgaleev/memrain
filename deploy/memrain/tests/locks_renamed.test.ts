/**
 * Lock names renamed outright: a page write, the migrator and a spend
 * reservation take only their `memrain` advisory keys, and the cycle and the
 * job worker hold only `memrain-*` rows. The reaper removes a dead
 * `memrain-cycle*` holder and never touches a `memex-*` row. Runs on PGLite,
 * and on Postgres when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import type { Engine } from "../src/core/engine/interface.ts";
import { runMigrations } from "../src/core/migrate.ts";
import { Storage } from "../src/core/storage.ts";
import { lockPageSlugs, putPage } from "../src/core/pages.ts";
import { reserveSpend } from "../src/core/budget.ts";
import { CYCLE_LOCK_ID, reapDeadHolderLocks, tryAcquireDbLock } from "../src/core/db-lock.ts";
import { DEFAULT_WORKER_LOCK_ID } from "../src/core/jobs/worker-lock.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { ENGINES, type Db } from "./helpers/migration-120.ts";

type Call = { sql: string; params: unknown[] };

function recording(inner: Engine, log: Call[]): Engine {
  const wrap = (e: Engine): Engine => ({
    kind: e.kind,
    ready: () => e.ready(),
    query: (sql, params = []) => {
      log.push({ sql, params });
      return e.query(sql, params);
    },
    exec: (sql) => {
      log.push({ sql, params: [] });
      return e.exec(sql);
    },
    close: () => e.close(),
    transaction: (fn) => e.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

/** The text keys handed to `hashtext` by advisory-lock calls in `log`. */
function advisoryKeys(log: Call[]): string[] {
  const keys: string[] = [];
  for (const c of log) {
    if (!/pg_advisory_xact_lock/.test(c.sql)) continue;
    const literal = /hashtext\('([^']+)'\)/.exec(c.sql);
    if (literal) keys.push(literal[1]!);
    else keys.push(String(c.params[0]));
  }
  return keys;
}

for (const { name, open } of ENGINES) {
  describe(`renamed lock keys and rows (${name})`, () => {
    let db: Db;

    beforeAll(async () => {
      db = await open();
      await runMigrations(db.engine);
    });
    afterAll(async () => {
      await db.close();
    });

    it("a page write holds memrain:page:<slug> and no memex:page: key", async () => {
      const held = await db.engine.transaction(async (tx) => {
        await lockPageSlugs(tx, "people/zoe");
        return (
          await tx.query<{ key: string }>(
            `SELECT k.key FROM (VALUES ('memrain:page:people/zoe'), ('memex:page:people/zoe')) AS k(key)
              WHERE EXISTS (SELECT 1 FROM pg_locks l
                             WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()
                               AND l.objid::bigint = (hashtext(k.key)::bigint & 4294967295))`,
          )
        ).rows.map((r) => r.key);
      });
      expect(held).toEqual(["memrain:page:people/zoe"]);

      const log: Call[] = [];
      await putPage(new Storage(recording(db.engine, log)), { slug: "people/zoe", type: "person", markdown_body: "Zoe" });
      expect(advisoryKeys(log)).toContain("memrain:page:people/zoe");
      expect(advisoryKeys(log).filter((k) => k.startsWith("memex:"))).toEqual([]);
    });

    it("the migrator takes memrain:migrations only", async () => {
      const log: Call[] = [];
      // Re-applies an idempotent migration. Not 001: its HNSW index names
      // vector_cosine_ops, which a column converted to halfvec (191) refuses.
      await db.engine.query(`DELETE FROM migrations WHERE id = 187`);
      try {
        const r = await runMigrations(recording(db.engine, log));
        expect(r.applied.map((m) => m.id)).toEqual([187]);
      } finally {
        await db.engine.query(`INSERT INTO migrations (id, name) VALUES (187, 'embedding_input_hash') ON CONFLICT DO NOTHING`);
      }
      expect([...new Set(advisoryKeys(log))]).toEqual(["memrain:migrations"]);
    });

    it("a spend reservation takes memrain_spend:<client> only", async () => {
      const log: Call[] = [];
      await reserveSpend(recording(db.engine, log), {
        clientId: "client-x",
        capUsd: null,
        estimatedUsd: 0.01,
        model: "m",
        provider: "p",
      });
      expect(advisoryKeys(log)).toEqual(["memrain_spend:client-x"]);
    });

    it("the cycle and the worker hold only memrain-* rows", async () => {
      expect(CYCLE_LOCK_ID).toBe("memrain-cycle");
      expect(DEFAULT_WORKER_LOCK_ID).toBe("memrain-jobs-worker");
      const handle = await tryAcquireDbLock(db.engine, CYCLE_LOCK_ID);
      expect(handle).not.toBeNull();
      const worker = new Worker(new Queue(db.engine), { engine: db.engine, logger: () => {} });
      worker.start();
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const r = await db.engine.query(`SELECT 1 FROM worker_lock`);
          if (r.rows.length > 0) break;
          await new Promise((res) => setTimeout(res, 10));
        }
        const cycles = await db.engine.query<{ id: string }>(`SELECT id FROM cycle_locks ORDER BY id`);
        const workers = await db.engine.query<{ id: string }>(`SELECT id FROM worker_lock ORDER BY id`);
        expect(cycles.rows.map((r) => r.id)).toEqual(["memrain-cycle"]);
        expect(workers.rows.map((r) => r.id)).toEqual(["memrain-jobs-worker"]);
      } finally {
        await worker.stop();
        await handle!.release();
      }
    });

    it("the reaper removes a dead memrain-cycle* holder and never a memex-* row", async () => {
      const host = hostname();
      await db.engine.exec(`
        INSERT INTO cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at) VALUES
          ('memrain-cycle', 100, '${host}', NOW() - interval '5 minutes', NOW() + interval '30 minutes'),
          ('memrain-cycle:embed', 101, '${host}', NOW() - interval '5 minutes', NOW() - interval '1 minute'),
          ('memex-cycle', 102, '${host}', NOW() - interval '5 minutes', NOW() + interval '30 minutes'),
          ('memex-cycle:embed', 103, '${host}', NOW() - interval '5 minutes', NOW() - interval '1 minute');
      `);
      const dead = new Set([100, 101, 102, 103]);
      const { reapedIds } = await reapDeadHolderLocks(db.engine, {
        processKill: (pid: number) => {
          if (dead.has(pid)) {
            const e = new Error("no such process") as NodeJS.ErrnoException;
            e.code = "ESRCH";
            throw e;
          }
        },
      });
      expect(reapedIds.sort()).toEqual(["memrain-cycle", "memrain-cycle:embed"]);
      const left = await db.engine.query<{ id: string }>(`SELECT id FROM cycle_locks ORDER BY id`);
      expect(left.rows.map((r) => r.id)).toEqual(["memex-cycle", "memex-cycle:embed"]);
      await db.engine.query(`DELETE FROM cycle_locks`);
    });
  });
}
