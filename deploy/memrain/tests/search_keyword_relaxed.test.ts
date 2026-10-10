import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { keywordSearchRelaxed, keywordSearchScored } from "../src/core/search/keyword.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  failingEmbed,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_KEYWORD_OR_RETRY";

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

describe("keywordSearchRelaxed", () => {
  it("matches chunks holding any of the query's words", async () => {
    const engine = fx.storage.engine();
    expect(await keywordSearchScored(engine, "quokka habitat survey", 20)).toEqual([]);
    const ids = (await keywordSearchRelaxed(engine, "quokka habitat survey", 20)).map((r) => r.id);
    expect(ids).toEqual(["quokka_c0", "survey_c0"]);
  });

  it("has no OR form for a single word", async () => {
    expect(await keywordSearchRelaxed(fx.storage.engine(), "quokka", 20)).toEqual([]);
  });

  it("drops stopwords and short words before building the OR", async () => {
    // "the" alone matches most of the fixture; "to"/"a" are short.
    const rows = await keywordSearchRelaxed(fx.storage.engine(), "the quokka and a survey to the", 20);
    expect(rows.map((r) => r.id)).toEqual(["quokka_c0", "survey_c0"]);
    // German function words go the same way.
    const de = await keywordSearchRelaxed(fx.storage.engine(), "der quokka und die survey für", 20);
    expect(de.map((r) => r.id)).toEqual(["quokka_c0", "survey_c0"]);
  });

  it("returns nothing when only stopwords and short words remain", async () => {
    expect(await keywordSearchRelaxed(fx.storage.engine(), "the and of a for", 20)).toEqual([]);
  });

  it("keeps the lexemes in query order when it caps them", async () => {
    // Sixteen fillers sort before "zephyr"; an alphabetical cap would drop it.
    const fillers = Array.from({ length: 16 }, (_, i) => `filler${String.fromCharCode(97 + i)}`);
    const rows = await keywordSearchRelaxed(fx.storage.engine(), ["zephyr", ...fillers].join(" "), 20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.id.startsWith("zephyr_"))).toBe(true);
  });

  it("takes query punctuation as data, never as tsquery syntax", async () => {
    const rows = await keywordSearchRelaxed(fx.storage.engine(), "quokka' | !survey & (:*", 20);
    expect(rows.map((r) => r.id)).toEqual(["quokka_c0", "survey_c0"]);
  });
});

describe("OR retry in hybridSearch", () => {
  it("recovers rows the AND pass missed, without keyword evidence", async () => {
    // Keyword-only: the AND pass is empty and only the title arm (slug leaf
    // "quokka") answers.
    const off = await runSearch(fx.storage, "quokka habitat survey", { embedQuery: failingEmbed });
    expect(off.hits.map((h) => h.chunkId)).toEqual(["quokka_c0"]);

    const on = await withRankFlag(FLAG, () =>
      runSearch(fx.storage, "quokka habitat survey", { embedQuery: failingEmbed }),
    );
    expect(on.hits.map((h) => h.chunkId)).toEqual(["quokka_c0", "survey_c0"]);
    expect(on.hits.every((h) => h.evidence === "weak_semantic")).toBe(true);
    expect(on.meta?.degraded).toContain("keyword_zero");
  });

  it("stays out of the way while the vector arm answers", async () => {
    const off = await runSearch(fx.storage, "quokka habitat survey");
    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "quokka habitat survey"));
    expect(on.hits).toEqual(off.hits);
  });

  it("does not run when the strict pass already has enough rows", async () => {
    // Three strict rows for "zephyr rollout"; the OR form would add the
    // rollout calendar.
    const on = await withRankFlag(FLAG, () =>
      runSearch(fx.storage, "zephyr rollout", { embedQuery: failingEmbed }),
    );
    expect(on.hits.map((h) => h.chunkId)).not.toContain("rollout_cal_c0");
  });
});
