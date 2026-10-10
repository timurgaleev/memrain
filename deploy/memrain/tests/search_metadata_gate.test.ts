import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { skipMetadataBoosts } from "../src/core/search/metadata-boost-gate.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_METADATA_GATE";

describe("skipMetadataBoosts", () => {
  it("skips only when on, the vector arm voted and no lexical arm did", () => {
    expect(skipMetadataBoosts({ enabled: true, vectorVoted: true, lexicalVoted: false })).toBe(true);
    expect(skipMetadataBoosts({ enabled: false, vectorVoted: true, lexicalVoted: false })).toBe(false);
    expect(skipMetadataBoosts({ enabled: true, vectorVoted: true, lexicalVoted: true })).toBe(false);
    // Keyword-only fallback: the lexical arms are all the recall there is.
    expect(skipMetadataBoosts({ enabled: true, vectorVoted: false, lexicalVoted: false })).toBe(false);
  });
});

describe("metadata gate in hybridSearch", () => {
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

  const order = (ids: string[], a: string, b: string): boolean => ids.indexOf(a) < ids.indexOf(b);

  it("lets the vector order stand on a vector-only query", async () => {
    // Nothing in the corpus holds "automobile" or "servicing": only the
    // embedder's synonyms reach the car notes. car_a is the closer match;
    // car_b carries frontmatter weight 2.
    const off = (await runSearch(fx.storage, "automobile servicing")).hits.map((h) => h.chunkId);
    expect(order(off, "car_b_c0", "car_a_c0")).toBe(true);

    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "automobile servicing", { explain: true }));
    const ids = on.hits.map((h) => h.chunkId);
    expect(order(ids, "car_a_c0", "car_b_c0")).toBe(true);
    const carB = on.hits.find((h) => h.chunkId === "car_b_c0")!;
    expect(carB.explain?.salience).toBeUndefined();
    expect(carB.explain?.recency).toBeUndefined();
  });

  it("keeps the boosts once a lexical arm votes", async () => {
    const off = await runSearch(fx.storage, "car maintenance");
    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "car maintenance"));
    expect(on.hits).toEqual(off.hits);
  });
});
