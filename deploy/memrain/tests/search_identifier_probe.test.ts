import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";
import { keywordIdentifierSearch } from "../src/core/search/keyword.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`identifier questions (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      db = await open();
      for (let i = 0; i <= 20; i++) {
        const content = `Weekly digest #${i === 20 ? 412 : 500 + i}: progress on deployment and customer reports.`;
        await writeDocumentTransaction(db.storage, {
          documentId: `digest_${i}`, sourcePath: `notes/digest-${i}`, title: "Weekly digest",
          frontmatter: {}, embeddingModel: "deterministic-test",
        }, [{ text: content, entities: [], embedding: deterministicEmbed(content) }]);
      }
    });
    afterAll(async () => { await db.close(); });
    const search = (query: string, extra = {}) => hybridSearch(db.storage, query, {
      k: 3, intent: "topic", noCache: true, noExpansion: true, rerank: false, embedQuery: deterministicEmbedQuery, ...extra,
    });

    it("finds the numbered digest even when the question words are absent from its body", async () => {
      const hits = await search("what did weekly digest #412 say", { embedQuery: async () => { throw new Error("offline"); } });
      expect(hits.map(h => h.documentId)).toContain("digest_20");
    });

    it("does not issue an extra keyword query for a question without identifiers", async () => {
      const e = db.storage.engine();
      const original = e.query.bind(e);
      const statements: string[] = [];
      const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
        if (sql.includes("search_vector")) statements.push(sql);
        return original(sql, params);
      });
      try { await search("weekly digest progress"); }
      finally { query.mockRestore(); }
      expect(statements).toHaveLength(1);
    });

    it("requires every identifier and honors source, date and visibility filters", async () => {
      const e = db.storage.engine();
      expect(await keywordIdentifierSearch(e, "find #412 and #500", 20)).toEqual([]);
      expect(await keywordIdentifierSearch(e, "find #412", 20, { sourceIds: [] })).toEqual([]);
      expect(await keywordIdentifierSearch(e, "find #412", 20, { filters: { since: "2099-01-01" } })).toEqual([]);
      await e.query("UPDATE documents SET deleted_at=now() WHERE id='digest_20'");
      try { expect(await keywordIdentifierSearch(e, "find #412", 20)).toEqual([]); }
      finally { await e.query("UPDATE documents SET deleted_at=NULL WHERE id='digest_20'"); }
    });

    it("does not repeat the primary keyword query for an identifier-only input", async () => {
      const query = spyOn(db.storage.engine(), "query");
      try {
        expect(await keywordIdentifierSearch(db.storage.engine(), "#412", 20)).toEqual([]);
        expect(query).not.toHaveBeenCalled();
      } finally { query.mockRestore(); }
    });

    it("marks a failed identifier probe and still returns surviving search results", async () => {
      const e = db.storage.engine();
      const original = e.query.bind(e);
      const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
        if (sql.includes("search_vector") && params?.[0] === "#412") throw new Error("probe failed");
        return original(sql, params);
      });
      let meta: SearchMeta | undefined;
      try {
        const hits = await search("what did weekly digest #412 say", { onMeta: (m: SearchMeta) => { meta = m; } });
        expect(hits.length).toBeGreaterThan(0);
        expect(meta?.degraded).toContain("keyword_candidates_incomplete");
      } finally { query.mockRestore(); }
    });
  });
}
