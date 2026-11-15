/**
 * Shadow ranking (MEMRAIN_RANK_SHADOW=<FLAG>): a search also ranks its fused
 * candidates with that flag flipped and records how the top results would
 * have moved in search_telemetry_shadow. The result the caller gets is the
 * unshadowed one, byte for byte; no query text is stored.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { loadBenchQrels, openBenchBrain, scoredQrels, type BenchBrain } from "../src/eval/bench/harness.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { classifyIntentZeroLlm } from "../src/core/search/intent.ts";
import { compareTop5, flushShadowTelemetry, readShadowStats, shadowFlag } from "../src/core/search/shadow.ts";
import { deterministicEmbedQuery } from "../src/eval/bench/deterministic-embed.ts";

setDefaultTimeout(120_000);

let brain: BenchBrain;
beforeAll(async () => {
  brain = await openBenchBrain();
});
afterAll(async () => {
  await brain.close();
});
afterEach(async () => {
  delete process.env.MEMRAIN_RANK_SHADOW;
  await flushShadowTelemetry();
  await brain.storage.engine().query(`DELETE FROM search_telemetry_shadow`);
});

const queries = () => scoredQrels(loadBenchQrels()).queries.slice(0, 12).map((q) => q.query);

const rows = async () => (await brain.storage.engine().query<{ flag: string; count: number; rank1_changed: number; sum_jaccard5: number }>(
  `SELECT flag, count, rank1_changed, sum_jaccard5 FROM search_telemetry_shadow ORDER BY flag`)).rows;

async function search(query: string, noTelemetry = false) {
  return hybridSearch(brain.storage, query, {
    k: 10, intent: classifyIntentZeroLlm(query), embedQuery: deterministicEmbedQuery, noCache: true,
    rerank: false, graphRerank: false, expansion: false, noExpansion: true, ...(noTelemetry ? { noTelemetry: true } : {}),
  });
}

describe("shadowFlag", () => {
  it("accepts only flags the post-fusion stages read", () => {
    expect(shadowFlag({ MEMRAIN_RANK_SHADOW: "EXACT_LOOKUP" })).toBe("EXACT_LOOKUP");
    expect(shadowFlag({ MEMRAIN_RANK_SHADOW: "metadata_gate" })).toBe("METADATA_GATE");
    // Page fusion and the keyword retries act before fusion: shadowing them
    // would need a second retrieval, which the shadow ranker never makes.
    expect(shadowFlag({ MEMRAIN_RANK_SHADOW: "PAGE_FUSION" })).toBeNull();
    expect(shadowFlag({ MEMRAIN_RANK_SHADOW: "NOT_A_FLAG" })).toBeNull();
    expect(shadowFlag({})).toBeNull();
  });
});

describe("compareTop5", () => {
  it("reports a changed first page and the overlap of the top five pages", () => {
    const doc = (d: string) => ({ documentId: d });
    expect(compareTop5([doc("a"), doc("b")], [doc("a"), doc("b")])).toEqual({ rank1Changed: false, jaccard5: 1 });
    expect(compareTop5([doc("a"), doc("b")], [doc("b"), doc("c")])).toEqual({ rank1Changed: true, jaccard5: 1 / 3 });
    expect(compareTop5([], [])).toEqual({ rank1Changed: false, jaccard5: 1 });
  });
});

describe("shadow ranking in hybridSearch", () => {
  it("returns byte-identical results and records one aggregate per search", async () => {
    // Recency multiplies by the age at search time; pin the clock so two runs
    // of one query can be compared byte for byte.
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-15T12:00:00Z"));
    const plain = [];
    for (const q of queries()) plain.push(JSON.stringify(await search(q)));
    process.env.MEMRAIN_RANK_SHADOW = "EXACT_LOOKUP";
    const shadowed = [];
    for (const q of queries()) shadowed.push(JSON.stringify(await search(q)));
    clock.mockRestore();
    expect(shadowed).toEqual(plain);
    await flushShadowTelemetry();
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.flag).toBe("EXACT_LOOKUP");
    expect(r[0]!.count).toBe(queries().length);
    expect(r[0]!.rank1_changed).toBeLessThanOrEqual(r[0]!.count);
    expect(r[0]!.sum_jaccard5).toBeGreaterThan(0);
  });

  it("records nothing for a call that opts out of telemetry, or for a flag it cannot shadow", async () => {
    process.env.MEMRAIN_RANK_SHADOW = "EXACT_LOOKUP";
    await search(queries()[0]!, true);
    process.env.MEMRAIN_RANK_SHADOW = "PAGE_FUSION";
    await search(queries()[1]!);
    await flushShadowTelemetry();
    expect(await rows()).toEqual([]);
  });
});

describe("readShadowStats", () => {
  it("sums a trailing window per flag into rates", async () => {
    const e = brain.storage.engine();
    const today = new Date().toISOString().slice(0, 10);
    await e.query(`INSERT INTO search_telemetry_shadow (date, flag, count, rank1_changed, sum_jaccard5) VALUES ($1, 'EXACT_LOOKUP', 10, 2, 9), ('2000-01-01', 'EXACT_LOOKUP', 50, 50, 0)`, [today]);
    expect(await readShadowStats(e, 7)).toEqual([{ flag: "EXACT_LOOKUP", count: 10, rank1_changed_rate: 0.2, mean_jaccard5: 0.9 }]);
  });
});
