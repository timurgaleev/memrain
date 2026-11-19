/**
 * Planner statistics. PGLite has no autovacuum, so a self-host brain plans
 * against tables that were never analyzed. With MEMRAIN_PGLITE_AUTO_ANALYZE on,
 * the hot tables are analyzed after a cycle and an import once their row count
 * has drifted from the planner's estimate; Postgres is left to autovacuum and
 * only reported on by the doctor.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { putPage } from "../src/core/pages.ts";
import { runCycleOnce } from "../src/core/cycle/index.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  analyzeQuietly,
  analyzeThreshold,
  checkPlannerStats,
  maybeAnalyzeHotTables,
  plannerStatsVerdict,
} from "../src/core/planner-stats.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(120000);

const FLAG = "MEMRAIN_PGLITE_AUTO_ANALYZE";
afterEach(() => { delete process.env[FLAG]; });

const [pglite, postgres] = storageEngines(process.env["MEMRAIN_TEST_POSTGRES_URL"]);

async function statRows(engine: { query<T>(s: string, p?: unknown[]): Promise<{ rows: T[] }> }, table: string): Promise<number> {
  const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = $1`, [table]);
  return r.rows[0]?.n ?? 0;
}

// Bulk rows straight into the table: the planner only cares how many there are.
async function seedPages(storage: Parameters<typeof putPage>[0], n: number, prefix = "bulk/p"): Promise<void> {
  await storage.engine().query(
    `INSERT INTO pages (slug, type, content_hash, source_id)
     SELECT $2 || '-' || g, 'note', md5(g::text), 'default' FROM generate_series(1, $1::int) g`,
    [n, prefix],
  );
}

describe("analyzeThreshold", () => {
  it("is the larger of 500 rows and a tenth of the estimate", () => {
    expect(analyzeThreshold(0)).toBe(500);
    expect(analyzeThreshold(4000)).toBe(500);
    expect(analyzeThreshold(20_000)).toBe(2000);
  });
});

describe("PGLite auto-analyze", () => {
  it("does nothing while the flag is off", async () => {
    const { storage, close } = await pglite!.open();
    try {
      await seedPages(storage, 600);
      const r = await maybeAnalyzeHotTables(storage.engine());
      expect(r).toEqual({ skipped: "off", analyzed: [] });
      expect(await statRows(storage.engine(), "pages")).toBe(0);
    } finally {
      await close();
    }
  });

  it("analyzes a never-analyzed hot table, then leaves it until it drifts", async () => {
    const { storage, close } = await pglite!.open();
    try {
      process.env[FLAG] = "1";
      await seedPages(storage, 600);
      const first = await maybeAnalyzeHotTables(storage.engine());
      expect(first.analyzed).toContain("pages");
      expect(await statRows(storage.engine(), "pages")).toBeGreaterThan(0);
      const second = await maybeAnalyzeHotTables(storage.engine());
      expect(second.analyzed).not.toContain("pages");
      await seedPages(storage, 510, "bulk/q");
      const third = await maybeAnalyzeHotTables(storage.engine());
      expect(third.analyzed).toContain("pages");
    } finally {
      await close();
    }
  });

  it("runs after a cycle", async () => {
    const { storage, close } = await pglite!.open();
    try {
      process.env[FLAG] = "1";
      await seedPages(storage, 600);
      await runCycleOnce(storage.engine(), { phases: ["snapshot"] });
      expect(await statRows(storage.engine(), "pages")).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe("analyzeQuietly", () => {
  it("reports a failed analyze instead of throwing, so a finished write is not reported as failed", async () => {
    process.env[FLAG] = "1";
    const broken = {
      kind: "pglite",
      query: async () => { throw new Error("relation is locked"); },
      exec: async () => { throw new Error("relation is locked"); },
    } as unknown as Engine;
    expect(await analyzeQuietly(broken)).toEqual({ analyze_error: "relation is locked" });
  });

  it("stays silent when nothing was analyzed", async () => {
    const { storage, close } = await pglite!.open();
    try {
      expect(await analyzeQuietly(storage.engine())).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe("doctor planner-stats", () => {
  it("decides from table stats alone", () => {
    expect(plannerStatsVerdict([{ table: "pages", live: 10_000, modified: 100 }]).status).toBe("ok");
    const stale = plannerStatsVerdict([{ table: "chunks", live: 10_000, modified: 5_000 }]);
    expect(stale.status).toBe("warn");
    expect(stale.detail).toContain("chunks");
    expect(stale.detail).toContain("ANALYZE");
  });

  it("warns on a never-analyzed PGLite brain and clears after analyze", async () => {
    const { storage, close } = await pglite!.open();
    try {
      await seedPages(storage, 600);
      const before = await checkPlannerStats(storage.engine());
      expect(before.name).toBe("planner-stats");
      expect(before.status).toBe("warn");
      expect(before.detail).toContain(FLAG);
      process.env[FLAG] = "1";
      await maybeAnalyzeHotTables(storage.engine());
      expect((await checkPlannerStats(storage.engine())).status).toBe("ok");
    } finally {
      await close();
    }
  });

  if (postgres) {
    it("leaves Postgres to autovacuum and reads its counters", async () => {
      const { storage, close } = await postgres.open();
      try {
        process.env[FLAG] = "1";
        expect(await maybeAnalyzeHotTables(storage.engine())).toEqual({ skipped: "postgres", analyzed: [] });
        const c = await checkPlannerStats(storage.engine());
        expect(["ok", "warn"]).toContain(c.status);
        expect(c.ok).toBe(true);
      } finally {
        await close();
      }
    });
  }
});
