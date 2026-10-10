import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { compiledTruthBoost } from "../src/core/search/hybrid.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_ENTITY_TRUTH_SOFT";

describe("compiledTruthBoost", () => {
  it("is ×2 at any low detail with the flag off", () => {
    expect(compiledTruthBoost(undefined, "low", false)).toBe(2);
    expect(compiledTruthBoost("low", "low", false)).toBe(2);
  });
  it("keeps ×2 for an asked-for low detail and softens a classifier guess", () => {
    expect(compiledTruthBoost("low", "low", true)).toBe(2);
    expect(compiledTruthBoost(undefined, "low", true)).toBe(1.2);
  });
  it("never boosts outside low detail", () => {
    expect(compiledTruthBoost(undefined, undefined, true)).toBe(1);
    expect(compiledTruthBoost("medium", "medium", false)).toBe(1);
    expect(compiledTruthBoost(undefined, "high", true)).toBe(1);
  });
});

describe("compiled-truth boost in hybridSearch", () => {
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

  const truthFactor = async (detail?: "low"): Promise<number | undefined> => {
    const { hits } = await runSearch(fx.storage, "tell me about zephyr", {
      explain: true,
      ...(detail ? { detail } : {}),
    });
    return hits.find((h) => h.chunkId === "zephyr_truth_c0")?.explain?.compiled_truth;
  };

  it("applies ×1.2 when only the classifier read the query as low detail", async () => {
    expect(await truthFactor()).toBe(2);
    expect(await withRankFlag(FLAG, () => truthFactor())).toBe(1.2);
  });

  it("applies ×2 when the caller asks for low detail", async () => {
    expect(await withRankFlag(FLAG, () => truthFactor("low"))).toBe(2);
  });
});
