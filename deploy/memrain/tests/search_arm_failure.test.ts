import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { openRankFixture, runSearch, type RankFixture } from "./rank-flags-fixture.ts";
import { publicSearchMeta } from "../src/core/search/search-meta.ts";

let fx: RankFixture;
beforeAll(async () => { fx = await openRankFixture(); });
afterAll(async () => { await fx.close(); });

describe("partial search failures", () => {
  for (const [code, reason] of [["57014", "keyword_timeout"], ["08006", "keyword_arm_failed"]] as const) {
    it(`keeps vector hits when keyword retrieval fails with ${code}`, async () => {
      const e = fx.storage.engine();
      const original = e.query.bind(e);
      const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
        if (sql.includes("search_vector")) throw Object.assign(new Error("test keyword fault"), { code });
        return original(sql, params);
      });
      try {
        const result = await runSearch(fx.storage, "zephyr rollout");
        expect(result.hits.some(h => h.documentId === "zephyr_page")).toBe(true);
        expect(result.meta?.degraded).toEqual([reason]);
        expect(publicSearchMeta(result.meta!).degraded).toEqual([reason]);
      } finally { query.mockRestore(); }
    });
  }

  it("reports a failed title lookup while returning lexical hits", async () => {
    const e = fx.storage.engine();
    const original = e.query.bind(e);
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("AS ident_title")) throw new Error("test title fault");
      return original(sql, params);
    });
    try {
      const result = await runSearch(fx.storage, "zephyr rollout");
      expect(result.hits.some(h => h.documentId === "zephyr_page")).toBe(true);
      expect(result.meta?.degraded).toEqual(["title_arm_failed"]);
    } finally { query.mockRestore(); }
  });

  it("keeps keyword hits when vector SQL fails", async () => {
    const e = fx.storage.engine();
    const original = e.query.bind(e);
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("FROM embeddings e")) throw Object.assign(new Error("test vector fault"), { code: "57014" });
      return original(sql, params);
    });
    try {
      const result = await runSearch(fx.storage, "zephyr rollout");
      expect(result.hits.some(h => h.documentId === "zephyr_page")).toBe(true);
      expect(result.meta?.degraded).toEqual(["vector_arm_failed"]);
      expect(result.meta?.vectorEnabled).toBe(false);
    } finally { query.mockRestore(); }
  });

  it("marks an incomplete expansion without discarding the primary hits", async () => {
    const e = fx.storage.engine();
    const original = e.query.bind(e);
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("search_vector") && params?.[0] === "expanded") throw Object.assign(new Error("test expanded fault"), { code: "57014" });
      return original(sql, params);
    });
    try {
      const result = await runSearch(fx.storage, "zephyr rollout", { noExpansion: false, expansion: true, expandQueryFn: async () => ["expanded"] });
      expect(result.hits.some(h => h.documentId === "zephyr_page")).toBe(true);
      expect(result.meta?.degraded).toEqual(["keyword_timeout"]);
    } finally { query.mockRestore(); }
  });
});
