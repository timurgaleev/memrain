import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { keywordSearchRelaxed, keywordSearchScored, RARE_LEXEME_CHUNK_CAP } from "../src/core/search/keyword.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  failingEmbed,
  openRankFixture,
  runSearch,
  type RankFixture,
} from "./rank-flags-fixture.ts";

// Five notes that repeat a common word, one page holding a rare one, one
// document whose chunks all hold a word too common to count as rare, and a
// hard-excluded fixture that would make the rare word look common if counted.
const EXTRA = [
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: `acme_${n}`,
    path: `notes/acme-${n}`,
    title: `Acme ${n}`,
    chunks: [`acme acme acme weekly acme report number ${n}`],
  })),
  { id: "zorb", path: "notes/zorb", title: "Migration", chunks: ["zorblat migration notes"] },
  {
    id: "bulk",
    path: "notes/bulk",
    title: "Bulk",
    chunks: Array.from({ length: RARE_LEXEME_CHUNK_CAP + 1 }, (_, i) => `blorp entry ${i}`),
  },
  {
    id: "wombats",
    path: "notes/wombats",
    title: "Wombats",
    chunks: Array.from({ length: 25 }, (_, i) => `wombat census entry ${i}`),
  },
  { id: "wombat_only", path: "notes/wombat-only", title: "Burrows", chunks: ["wombat burrows"] },
  {
    id: "excluded_fixture",
    path: "test/zorblat-fixture",
    title: "Fixture",
    chunks: Array.from({ length: RARE_LEXEME_CHUNK_CAP + 1 }, (_, i) => `zorblat fixture ${i}`),
  },
];

let fx: RankFixture;
beforeAll(async () => {
  clearRankFlags();
  setSystemTime(FIXED_NOW);
  fx = await openRankFixture(EXTRA);
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

  // Value: protects=the one page holding the rare word leads; fails_when=rows go back to ts_rank
  // order, where chunks repeating the common word outrank it, or the hard-excluded test/ fixture
  // counts toward the word's commonness.
  it("ranks the page holding the rarer word first", async () => {
    const engine = fx.storage.engine();
    const rank = (await keywordSearchScored(engine, "acme", 20)).map((r) => r.id);
    expect(rank).toHaveLength(5);
    const ids = (await keywordSearchRelaxed(engine, "acme zorblat", 20)).map((r) => r.id);
    expect(ids[0]).toBe("zorb_c0");
    expect(ids.slice(1).sort()).toEqual([...rank].sort());
  });

  // Value: protects=a failed rarity count costs ordering, not results;
  // fails_when=the count's error makes the whole relaxed search throw.
  it("falls back to the plain OR when the rarity count fails", async () => {
    const real = fx.storage.engine();
    const engine = new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "query" || typeof v !== "function") return v;
        return (sql: string, params?: unknown[]) => {
          if (sql.includes("FROM unnest($1::text[]) AS u(lex)")) return Promise.reject(new Error("count timed out"));
          return (v as (s: string, p?: unknown[]) => unknown).call(target, sql, params);
        };
      },
    }) as typeof real;
    const ids = (await keywordSearchRelaxed(engine, "acme zorblat", 20)).map((r) => r.id);
    expect(ids.sort()).toEqual((await keywordSearchRelaxed(real, "acme zorblat", 20)).map((r) => r.id).sort());
  });

  // Value: protects=an any-word search still returns pages holding only a common word;
  // fails_when=the OR is narrowed to the rare words.
  it("keeps chunks holding only a common word, after the rare ones", async () => {
    const ids = (await keywordSearchRelaxed(fx.storage.engine(), "blorp zorblat", 20)).map((r) => r.id);
    expect(ids[0]).toBe("zorb_c0");
    expect(ids.length).toBe(20);
    expect(ids.slice(1).every((id) => id.startsWith("bulk_"))).toBe(true);
  });
});

describe("any-word fill in hybridSearch", () => {
  // Value: protects=a keyword-only search whose words no single chunk holds still answers;
  // fails_when=the fill is gated off or the empty-candidates return comes first.
  it("answers a keyword-only query no chunk fully matches", async () => {
    const { hits, meta } = await runSearch(fx.storage, "habitat survey", { embedQuery: failingEmbed });
    expect(hits.map((h) => h.chunkId)).toEqual(["quokka_c0", "survey_c0"]);
    expect(hits.every((h) => h.evidence === "weak_semantic")).toBe(true);
    expect(meta?.degraded).toContain("keyword_zero");
  });

  // Value: protects=strict rows never move and the fill sorts after them; fails_when=fill rows are
  // fused into the ranking or scored above a strict row. k=2 and k=6 share the fanout (20), so the
  // only difference between the two calls is the fill.
  it("appends below the strict rows without reordering them", async () => {
    const strict = await runSearch(fx.storage, "zephyr rollout", { embedQuery: failingEmbed, k: 2 });
    const filled = await runSearch(fx.storage, "zephyr rollout", { embedQuery: failingEmbed, k: 6 });
    expect(strict.hits).toHaveLength(2);
    expect(filled.hits.slice(0, 2)).toEqual(strict.hits);
    // The zephyr page already holds its slots; the rollout calendar fills the next one.
    expect(filled.hits.slice(2).map((h) => h.chunkId)).toEqual(["rollout_cal_c0"]);
    expect(filled.hits[2]!.score).toBeLessThan(filled.hits[1]!.score);
  });

  // Value: protects=partial-word pages never take slots while more all-word rows exist;
  // fails_when=the fill runs after a strict pass that filled its fanout and was cut by the page cap.
  it("does not fill when the strict pass filled its fanout", async () => {
    const { hits } = await runSearch(fx.storage, "wombat census", { embedQuery: failingEmbed, k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.documentId === "wombats")).toBe(true);
  });
});
