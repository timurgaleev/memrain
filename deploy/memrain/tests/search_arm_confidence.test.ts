import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { downweightKeywordArm, keywordMargin } from "../src/core/search/arm-confidence.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_KEYWORD_CONFIDENCE";

describe("keywordMargin", () => {
  it("is 0 for an empty arm and 1 for a single page", () => {
    expect(keywordMargin([])).toBe(0);
    expect(keywordMargin([{ documentId: "a", score: 0.3 }, { documentId: "a", score: 0.1 }])).toBe(1);
  });
  it("compares the best score of the top two distinct pages", () => {
    expect(keywordMargin([{ documentId: "a", score: 0.2 }, { documentId: "b", score: 0.2 }])).toBe(0.5);
    expect(
      keywordMargin([
        { documentId: "a", score: 0.3 },
        { documentId: "a", score: 0.29 },
        { documentId: "b", score: 0.1 },
      ]),
    ).toBeCloseTo(0.75, 10);
  });
});

describe("downweightKeywordArm", () => {
  const tied = [{ documentId: "a", score: 0.2 }, { documentId: "b", score: 0.2 }];
  it("fires only for an unsure arm with a vector arm to defer to", () => {
    expect(downweightKeywordArm({ enabled: true, keywordRows: tied, vectorVoted: true, relationalVoted: false })).toBe(true);
    expect(downweightKeywordArm({ enabled: false, keywordRows: tied, vectorVoted: true, relationalVoted: false })).toBe(false);
    expect(downweightKeywordArm({ enabled: true, keywordRows: tied, vectorVoted: false, relationalVoted: false })).toBe(false);
    expect(downweightKeywordArm({ enabled: true, keywordRows: tied, vectorVoted: true, relationalVoted: true })).toBe(false);
    expect(
      downweightKeywordArm({
        enabled: true,
        keywordRows: [{ documentId: "a", score: 0.9 }, { documentId: "b", score: 0.1 }],
        vectorVoted: true,
        relationalVoted: false,
      }),
    ).toBe(false);
  });
});

describe("keyword confidence in hybridSearch", () => {
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

  const bases = async (query: string): Promise<Map<string, number>> => {
    const { hits } = await runSearch(fx.storage, query, { explain: true });
    return new Map(hits.map((h) => [h.chunkId, h.explain!.base]));
  };

  it("halves the keyword vote when its top two pages tie", async () => {
    // "vehicle repair": the invoice and the receipt match it identically.
    const off = await bases("vehicle repair");
    const on = await withRankFlag(FLAG, () => bases("vehicle repair"));
    expect(on.get("veh_k1_c0")!).toBeLessThan(off.get("veh_k1_c0")!);
    expect(on.get("veh_k2_c0")!).toBeLessThan(off.get("veh_k2_c0")!);
    // A vector-only hit fuses exactly as before.
    expect(on.get("veh_v_c0")).toBe(off.get("veh_v_c0"));
  });

  it("leaves a decisive keyword arm alone", async () => {
    // Only one page holds both words: nothing contests it.
    const off = await runSearch(fx.storage, "quokka habitat");
    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "quokka habitat"));
    expect(on.hits).toEqual(off.hits);
  });
});
