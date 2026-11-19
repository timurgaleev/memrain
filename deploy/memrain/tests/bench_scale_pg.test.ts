/**
 * `memrain bench scale` against a real Postgres: the bench writes only into a
 * database it created and marked itself, refuses one holding anything that is
 * not its own, spends nothing, and leaves no database behind.
 *
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch server. The
 * bench creates and drops databases, so it takes the direct URL when a pooler
 * run supplies one.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import {
  ScaleBenchRefusal,
  assertBenchTarget,
  createScratchDatabase,
  dropScratchDatabase,
  loadScaleCorpus,
  openBenchBrain,
  runScaleBench,
  type ScratchTarget,
} from "../src/core/bench/scale.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_DIRECT_URL ?? process.env.MEMRAIN_TEST_POSTGRES_URL;

async function count(engine: PostgresEngine, sql: string): Promise<number> {
  const r = await engine.query<{ n: number }>(sql);
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!URL_)("bench scale on Postgres", () => {
  const made: ScratchTarget[] = [];

  afterAll(async () => {
    for (const t of made) await dropScratchDatabase(URL_!, t).catch(() => undefined);
  });

  it("refuses a database holding a page that is not the bench's, and writes nothing", async () => {
    const target = await createScratchDatabase(URL_!, { env: {} });
    made.push(target);
    const brain = await openBenchBrain(target);
    try {
      await brain.engine.query(
        `INSERT INTO pages (slug, type, title, content_hash, source_id)
         VALUES ('people/someone', 'person', 'Someone', 'h', 'default')`,
      );
      const err = await loadScaleCorpus(brain.engine, target, { seed: "1", chunks: 30 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ScaleBenchRefusal);
      expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_live_db");
      expect(await count(brain.engine, "SELECT count(*)::int AS n FROM chunks")).toBe(0);
      expect(await count(brain.engine, "SELECT count(*)::int AS n FROM documents")).toBe(0);
      expect(await count(brain.engine, "SELECT count(*)::int AS n FROM embeddings")).toBe(0);
    } finally {
      await brain.engine.close();
    }
  });

  it("refuses a database it did not create: no marker, or the wrong nonce", async () => {
    const foreign = new PostgresEngine({ url: URL_!, max: 1 });
    try {
      const db = (await foreign.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
      const err = await assertBenchTarget(foreign, { dbName: db, nonce: "x" }).catch((e: unknown) => e);
      expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_foreign_db");
    } finally {
      await foreign.close();
    }

    const target = await createScratchDatabase(URL_!, { env: {} });
    made.push(target);
    const e = new PostgresEngine({ url: target.url, max: 1 });
    try {
      await assertBenchTarget(e, target);
      const err = await assertBenchTarget(e, { ...target, nonce: "0".repeat(32) }).catch((x: unknown) => x);
      expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_foreign_db");
    } finally {
      await e.close();
    }
  });

  it("drops only a database carrying this run's nonce", async () => {
    const target = await createScratchDatabase(URL_!, { env: {} });
    made.push(target);
    const err = await dropScratchDatabase(URL_!, { ...target, nonce: "f".repeat(32) }).catch((e: unknown) => e);
    expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_foreign_db");
    const admin = new PostgresEngine({ url: URL_!, max: 1 });
    try {
      const has = async () =>
        (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [target.dbName])).rows.length;
      expect(await has()).toBe(1);
      await dropScratchDatabase(URL_!, target);
      expect(await has()).toBe(0);
      // Already gone: a second cleanup pass is a no-op, not an error.
      await dropScratchDatabase(URL_!, target);
    } finally {
      await admin.close();
    }
  });

  it("refuses to drop a database that is no longer the one it created, even under the same name and nonce", async () => {
    const target = await createScratchDatabase(URL_!, { env: {} });
    made.push(target);
    const err = await dropScratchDatabase(URL_!, { ...target, oid: target.oid + 1 }).catch((e: unknown) => e);
    expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_foreign_db");
    const admin = new PostgresEngine({ url: URL_!, max: 1 });
    try {
      const left = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [target.dbName]);
      expect(left.rows).toHaveLength(1);
    } finally {
      await admin.close();
    }
  });

  it("runs a small end-to-end bench: report shape, zero spend, every hybrid vector from the seam, no database left", async () => {
    // Paid knobs set in the shell must not reach the run.
    const saved = { ...process.env };
    process.env.MEMRAIN_INTENT_LLM = "1";
    process.env.MEMRAIN_RERANK = "1";
    process.env.MEMRAIN_QUERY_EXPANSION = "1";
    try {
      const report = await runScaleBench({
        adminUrl: URL_!,
        scratch: true,
        env: {},
        seed: "3",
        chunks: 200,
        tenants: 2,
        concurrency: 2,
        queries: 10,
        runs: 2,
        warmup: 2,
      });

      const s1 = report.scenarios.s1;
      expect(s1.chunks).toBe(200);
      expect(s1.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s1.keyword.samples).toBe(20);
      expect(s1.hybrid.samples).toBe(20);
      expect(s1.keyword.runP95).toHaveLength(2);
      expect(["pass", "fail"]).toContain(s1.verdict.hybrid);
      expect(["pass", "fail"]).toContain(s1.verdict.keyword);
      expect(s1.errors).toEqual({});

      const s2 = report.scenarios.s2Direct;
      expect(s2.tenants).toHaveLength(2);
      expect(s2.connectionErrors).toBe(0);
      expect(s2.verdict).toBe("pass");
      expect(report.scenarios.s2Pooler.skipped).toBe(true);
      expect(report.scenarios.s4Cold.skipped).toBe(true);

      expect(report.spend.ledgerCalls).toBe(0);
      expect(report.spend.embedSeamCalls).toBe(report.spend.hybridQueries);
      expect(report.spend.hybridQueries).toBeGreaterThan(0);
      expect(report.peakConnections.total).toBeGreaterThan(0);
      expect(report.protocol.compliant).toBe(false);
      expect(JSON.stringify(report)).not.toContain(new URL(URL_!).password || "\u0000");

      const admin = new PostgresEngine({ url: URL_!, max: 1 });
      try {
        const left = await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
          [report.databases],
        );
        expect(left.rows).toEqual([]);
      } finally {
        await admin.close();
      }
    } finally {
      for (const k of ["MEMRAIN_INTENT_LLM", "MEMRAIN_RERANK", "MEMRAIN_QUERY_EXPANSION"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }, 180_000);
});
