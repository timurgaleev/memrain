/**
 * `memrain bench scale`, the parts that need no database: the corpus is a pure
 * function of its seed, the query mix keeps its shares, the percentile is
 * nearest-rank, a miss against a target is reported rather than thrown, and the
 * refusals that protect a live brain fire before any connection is opened.
 * The database half lives in bench_scale_pg.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  BENCH_EMBED_DIMS,
  QUERY_MIX,
  benchQueryVector,
  corpusBatches,
  corpusDigest,
  queryList,
} from "../src/core/bench/scale-corpus.ts";
import {
  Q51_TARGETS,
  ScaleBenchRefusal,
  assertBenchTarget,
  assertBenchContainer,
  assertNotProductionServer,
  assertPoolerBesideAdmin,
  assertContainerServes,
  armFailures,
  judge,
  percentileNearestRank,
  runScaleBench,
  summarizeRuns,
  tenantEngineOptions,
} from "../src/core/bench/scale.ts";
import { buildPostgresOptions } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";

describe("scale corpus", () => {
  it("one seed gives one digest; another seed gives another", () => {
    const a = corpusDigest({ seed: "7", chunks: 120 });
    expect(corpusDigest({ seed: "7", chunks: 120 })).toBe(a);
    expect(corpusDigest({ seed: "8", chunks: 120 })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits exactly the requested chunk count, each with a unit 1024-d vector", () => {
    let chunks = 0;
    for (const b of corpusBatches({ seed: "1", chunks: 33 }, 2)) {
      for (const c of b.chunks) {
        chunks++;
        const v = JSON.parse(c.vector) as number[];
        expect(v).toHaveLength(BENCH_EMBED_DIMS);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(0.01);
        expect(c.content.length).toBeGreaterThan(0);
      }
    }
    expect(chunks).toBe(33);
  });

  it("query vectors are deterministic and differ per query", () => {
    expect(benchQueryVector("1", "kalo")).toEqual(benchQueryVector("1", "kalo"));
    expect(benchQueryVector("1", "kalo")).not.toEqual(benchQueryVector("1", "kalu"));
  });
});

describe("query mix", () => {
  it("keeps the fixed shares and the requested length", () => {
    const qs = queryList("1", "run", 200);
    expect(qs).toHaveLength(200);
    for (const m of QUERY_MIX) {
      expect(qs.filter((q) => q.kind === m.kind)).toHaveLength(Math.round(m.share * 200));
    }
  });

  it("is deterministic per seed and label", () => {
    expect(queryList("1", "run", 50)).toEqual(queryList("1", "run", 50));
    expect(queryList("1", "run", 50)).not.toEqual(queryList("1", "warmup", 50));
    expect(queryList("2", "run", 50)).not.toEqual(queryList("1", "run", 50));
  });

  it("sums to the requested count when the shares do not divide it", () => {
    expect(queryList("1", "run", 7)).toHaveLength(7);
  });
});

describe("statistics", () => {
  it("p95 is nearest-rank: the ceil(0.95·n)-th smallest sample", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentileNearestRank(xs, 0.95)).toBe(19);
    expect(percentileNearestRank(xs, 0.5)).toBe(10);
    expect(percentileNearestRank([5], 0.99)).toBe(5);
  });

  it("summarizes runs with per-run p95s, pooled percentiles and spread", () => {
    const s = summarizeRuns([[10, 20, 30], [12, 22, 32], [11, 21, 31]]);
    expect(s.samples).toBe(9);
    expect(s.runP95).toEqual([30, 32, 31]);
    expect(s.p95).toBe(32);
    expect(s.spreadP95).toBeCloseTo((32 - 30) / 31, 6);
  });

  it("a search that lost an arm counts as a failure, not a sample", () => {
    expect(armFailures(["keyword_arm_failed"])).toEqual(["keyword_arm_failed"]);
    expect(armFailures(["vector_arm_failed", "keyword_zero"])).toEqual(["vector_arm_failed"]);
    expect(armFailures(["embed_timeout", "keyword_timeout", "title_arm_failed"])).toHaveLength(3);
    // Only a failed identifier probe reports this one.
    expect(armFailures(["keyword_candidates_incomplete"])).toEqual(["keyword_candidates_incomplete"]);
    // No hit and an incomplete candidate list are results, not failures.
    expect(armFailures(["keyword_zero", "vector_candidates_incomplete", "budget_truncated"])).toEqual([]);
  });

  it("a miss against a Q51 target is marked fail, not thrown", () => {
    expect(judge(900, Q51_TARGETS.hybridP95Ms)).toBe("fail");
    expect(judge(100, Q51_TARGETS.hybridP95Ms)).toBe("pass");
    expect(judge(null, Q51_TARGETS.keywordP95Ms)).toBe("no_data");
  });
});

describe("refusals that protect a live brain", () => {
  const PROD = "postgres://app:secret@db.internal.example:5432/memrain?sslmode=require";

  it("refuses the production server, whatever database name the URL carries", () => {
    const env = { MEMRAIN_POSTGRES_URL: PROD };
    expect(() =>
      assertNotProductionServer("postgres://u:p@db.internal.example:5432/postgres", env),
    ).toThrow(expect.objectContaining({ code: "bench_refuses_prod_url" }));
    expect(() =>
      assertNotProductionServer("postgres://u:p@db.internal.example/other", env),
    ).toThrow(expect.objectContaining({ code: "bench_refuses_prod_url" }));
    // A different server is fine.
    assertNotProductionServer("postgres://u:p@127.0.0.1:55432/postgres", env);
  });

  it("treats every loopback spelling as the same host", () => {
    const env = { MEMRAIN_CONTROL_URL: "postgres://a:b@localhost:6543/control" };
    expect(() => assertNotProductionServer("postgres://u:p@127.0.0.1:6543/x", env)).toThrow(
      expect.objectContaining({ code: "bench_refuses_prod_url" }),
    );
  });

  it("refuses the production URL even with --scratch, before connecting anywhere", async () => {
    // Port 1 has no listener: if the run tried to connect, the error would be a
    // connection error, not the refusal.
    const url = "postgres://u:p@127.0.0.1:1/postgres?sslmode=disable";
    const err = await runScaleBench({
      adminUrl: url,
      scratch: true,
      env: { MEMRAIN_POSTGRES_URL: url },
      chunks: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScaleBenchRefusal);
    expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_prod_url");
  });

  it("refuses to run without --scratch", async () => {
    const err = await runScaleBench({
      adminUrl: "postgres://u:p@127.0.0.1:1/postgres?sslmode=disable",
      scratch: false,
      env: {},
      chunks: 10,
    }).catch((e: unknown) => e);
    expect((err as ScaleBenchRefusal).code).toBe("bench_needs_scratch");
  });

  it("refuses PGLite without issuing a single query", async () => {
    const seen: string[] = [];
    const fake = {
      kind: "pglite",
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [] };
      },
    } as unknown as Engine;
    const err = await assertBenchTarget(fake, { dbName: "memrain_bench_0123456789abcdef", nonce: "n" }).catch(
      (e: unknown) => e,
    );
    expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_pglite");
    expect(seen).toEqual([]);
  });

  it("refuses a pooler on any host but the admin server's, before connecting", async () => {
    const err = await runScaleBench({
      adminUrl: "postgres://u:p@127.0.0.1:1/postgres?sslmode=disable",
      poolerUrl: "postgres://u:p@pooler.internal.example:6432/postgres",
      scratch: true,
      env: {},
      chunks: 10,
    }).catch((e: unknown) => e);
    expect((err as ScaleBenchRefusal).code).toBe("bench_refuses_pooler_host");
    assertPoolerBesideAdmin("postgres://u:p@localhost:6432/x", "postgres://u:p@127.0.0.1:5432/postgres");
  });

  it("takes a container's limits only when it publishes the admin URL's port on loopback", () => {
    const binding = (port: string, ip = "127.0.0.1") => ({ PortBindings: { "5432/tcp": [{ HostIp: ip, HostPort: port }] } });
    const admin = "postgres://u:p@127.0.0.1:55432/postgres";
    assertContainerServes(binding("55432"), admin);
    for (const [cfg, url] of [
      [binding("55433"), admin],
      [{ PortBindings: {} }, admin],
      [binding("55432"), "postgres://u:p@db.internal.example:55432/postgres"],
    ] as const) {
      expect(() => assertContainerServes(cfg, url)).toThrow(
        expect.objectContaining({ code: "bench_refuses_container" }),
      );
    }
  });

  it("restarts only a container the bench script started", () => {
    assertBenchContainer("memrain-scale-bench-123-456");
    for (const bad of ["deploy-memrain-1", "postgres", "memrain-scale-bench-", "x;rm -rf /"]) {
      expect(() => assertBenchContainer(bad)).toThrow(
        expect.objectContaining({ code: "bench_refuses_container" }),
      );
    }
  });
});

describe("tenant engines", () => {
  it("a pooled tenant connects as a hosted one does: no session timeouts at startup", () => {
    const pooled = buildPostgresOptions(tenantEngineOptions("postgres://u:p@h/db?sslmode=disable", "pooler"));
    expect(pooled.connection).not.toHaveProperty("statement_timeout");
    expect(pooled.connection).not.toHaveProperty("idle_in_transaction_session_timeout");
    expect(pooled.max).toBe(4);
  });

  it("a direct tenant keeps the timeouts it sends today", () => {
    const direct = buildPostgresOptions(tenantEngineOptions("postgres://u:p@h/db?sslmode=disable", "direct"));
    expect(direct.connection).toHaveProperty("statement_timeout");
    expect(direct.max).toBe(4);
  });
});
