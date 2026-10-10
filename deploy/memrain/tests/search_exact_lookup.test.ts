import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { promoteExactLookup } from "../src/core/search/exact-lookup.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  withRankFlag,
  type RankFixture,
} from "./rank-flags-fixture.ts";

const FLAG = "MEMRAIN_RANK_EXACT_LOOKUP";

const hit = (documentId: string, score: number, title: string, sourcePath: string) => ({
  chunkId: `${documentId}_c0`,
  documentId,
  score,
  payload: { title, sourcePath, source_id: null },
});

describe("promoteExactLookup", () => {
  it("moves the one named page to rank 1 and keeps the rest in order", () => {
    const hits = [
      hit("a", 0.05, "Pricing", "notes/a"),
      hit("b", 0.04, "Onboarding", "notes/b"),
      hit("q", 0.03, "Quandalore", "notes/quandalore"),
      hit("c", 0.02, "Other", "notes/c"),
    ];
    const out = promoteExactLookup(hits, "quandalore");
    expect(out.map((h) => h.documentId)).toEqual(["q", "a", "b", "c"]);
    expect(out[0]!.score).toBeGreaterThan(0.05);
    expect(hits[2]!.score).toBe(0.03);
  });

  it("treats a page and its compiled-truth mirror as one page", () => {
    const hits = [
      hit("a", 0.05, "Pricing", "notes/a"),
      hit("t", 0.04, "Zephyr", "page-truth://projects/zephyr"),
      hit("p", 0.03, "Zephyr", "page://projects/zephyr"),
    ];
    expect(promoteExactLookup(hits, "Zephyr").map((h) => h.documentId)).toEqual(["t", "a", "p"]);
  });

  it("leaves the list alone when two pages carry the name", () => {
    const hits = [
      hit("a", 0.05, "Pricing", "notes/a"),
      hit("q1", 0.04, "Quandalore", "notes/quandalore"),
      hit("q2", 0.03, "Quandalore", "archive/quandalore-old"),
    ];
    expect(promoteExactLookup(hits, "quandalore")).toEqual(hits);
  });

  it("leaves the list alone when the query names nothing", () => {
    const hits = [hit("a", 0.05, "Pricing", "notes/a"), hit("b", 0.04, "Other", "notes/b")];
    expect(promoteExactLookup(hits, "quandalore pricing")).toEqual(hits);
  });
});

describe("exact lookup in hybridSearch", () => {
  let fx: RankFixture;
  beforeAll(async () => {
    clearRankFlags();
    setSystemTime(FIXED_NOW);
    // A body that repeats the name, carrying frontmatter weight 2, outranks
    // the page that IS the name.
    fx = await openRankFixture([
      {
        id: "quand_sheet",
        path: "notes/q-sheet",
        title: "Price sheet",
        frontmatter: { weight: 2 },
        chunks: ["quandalore quandalore price sheet"],
      },
    ]);
  });
  afterAll(async () => {
    setSystemTime();
    await fx.close();
  });

  it("puts the page the whole query names first", async () => {
    const off = await runSearch(fx.storage, "Quandalore");
    expect(off.hits[0]!.chunkId).not.toBe("quand_c0");

    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "Quandalore"));
    expect(on.hits[0]!.chunkId).toBe("quand_c0");
    const rest = (hits: typeof off.hits): string[] =>
      hits.map((h) => h.chunkId).filter((id) => id !== "quand_c0");
    expect(rest(on.hits)).toEqual(rest(off.hits));
  });

  it("does nothing for a query that is not a page name", async () => {
    const off = await runSearch(fx.storage, "zephyr rollout");
    const on = await withRankFlag(FLAG, () => runSearch(fx.storage, "zephyr rollout"));
    expect(on.hits).toEqual(off.hits);
  });
});
