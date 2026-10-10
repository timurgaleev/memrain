import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { fuseByPage, pageKeyFor } from "../src/core/search/page-fusion.ts";
import { reciprocalRankFusion } from "../src/core/rrf.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_PAGE_FUSION";

describe("pageKeyFor", () => {
  it("puts a page, its compiled-truth mirror and its file twin on one key", () => {
    const page = pageKeyFor("page://people/alice", null, "d1");
    expect(pageKeyFor("page-truth://people/alice", null, "d2")).toBe(page);
    expect(pageKeyFor("people/alice.md", null, "d3")).toBe(page);
    expect(pageKeyFor("page://people/alice", "other", "d4")).not.toBe(page);
  });
  it("keeps a path with no slug form as its own page", () => {
    expect(pageKeyFor("/abs/file.ts", null, "d1")).toBe("doc:d1");
  });
});

describe("fuseByPage", () => {
  const pages: Record<string, string> = { p1: "P", p2: "P", q1: "Q", r1: "R" };
  const pageOf = (id: string): string | undefined => pages[id];

  it("lets cross-arm agreement on one page beat a single arm's first place", () => {
    // P is second in both lists, through a different chunk in each.
    const vector = ["r1", "p2"];
    const keyword = ["q1", "p1"];
    const chunkGrain = reciprocalRankFusion([vector, keyword]).map((r) => r.id);
    expect(chunkGrain.slice(0, 2).sort()).toEqual(["q1", "r1"]);

    const fused = fuseByPage([vector, keyword], { pageOf });
    expect(fused[0]!.id).toBe("p2");
    expect(fused[0]!.score).toBeCloseTo(2 / 62, 12);
    expect(fused[0]!.votes).toEqual([
      { list: 0, rank: 2 },
      { list: 1, rank: 2 },
    ]);
    // The page's other chunk keeps only its own vote.
    expect(fused.find((r) => r.id === "p1")!.score).toBeCloseTo(1 / 62, 12);
  });

  it("matches chunk-grain RRF when every chunk is its own page", () => {
    const lists = [["a", "b", "c"], ["c", "a"], ["b"]];
    const weights = [1, 0.5, 2];
    const chunkGrain = reciprocalRankFusion(lists, { weights });
    const fused = fuseByPage(lists, { weights, pageOf: () => undefined });
    expect(fused.map(({ id, score }) => ({ id, score }))).toEqual(chunkGrain);
  });
});

describe("page fusion in hybridSearch", () => {
  let fx: RankFixture;
  beforeAll(async () => {
    clearRankFlags();
    setSystemTime(FIXED_NOW);
    fx = await openRankFixture();
  });
  afterAll(async () => {
    setSystemTime();
    await fx.close();
  });

  const zephyrHits = (ids: string[]): string[] => ids.filter((id) => id.startsWith("zephyr_"));

  it("gives a page and its compiled-truth mirror one per-page cap", async () => {
    const off = await runSearch(fx.storage, "zephyr rollout");
    expect(zephyrHits(off.hits.map((h) => h.chunkId))).toHaveLength(3);

    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "zephyr rollout", { explain: true }));
    const ids = zephyrHits(on.hits.map((h) => h.chunkId));
    expect(ids).toHaveLength(2);
    // The lead carries every list's vote for the page.
    const lead = on.hits.find((h) => h.chunkId === ids[0])!;
    expect(lead.explain?.arms?.map((a) => a.arm)).toEqual(expect.arrayContaining(["vector", "keyword", "title"]));
  });
});
