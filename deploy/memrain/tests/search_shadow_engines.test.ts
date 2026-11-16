/**
 * The shadow rollup's upsert on both engines. The shadow ranker swallows every
 * error so it can never break a search, so a write Postgres refuses would only
 * show up as counts that never move; this test reads them back.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { indexDocument } from "../src/core/indexer.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { classifyIntentZeroLlm } from "../src/core/search/intent.ts";
import { flushShadowTelemetry, readShadowStats } from "../src/core/search/shadow.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

afterEach(() => {
  delete process.env.MEMRAIN_RANK_SHADOW;
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`shadow rollup (${name})`, () => {
  it("adds each shadowed search to the day's row for its flag", async () => {
    const { storage, close } = await open();
    try {
      for (const [path, text] of [
        ["/notes/ledger.md", "# Ledger\n\nThe ledger reconciliation service is owned by the billing team."],
        ["/notes/garden.md", "# Garden\n\nTomatoes need sun in the south bed."],
      ] as const) {
        await indexDocument(storage, { sourcePath: path, text }, { embedFn: async (t) => deterministicEmbed(t), inferFrontmatter: false });
      }
      process.env.MEMRAIN_RANK_SHADOW = "EXACT_LOOKUP";
      for (const query of ["ledger", "who owns the ledger service"]) {
        await hybridSearch(storage, query, {
          k: 10, intent: classifyIntentZeroLlm(query), embedQuery: deterministicEmbedQuery, noCache: true,
          rerank: false, graphRerank: false, expansion: false, noExpansion: true,
        });
      }
      await flushShadowTelemetry();
      const stats = await readShadowStats(storage.engine(), 7);
      expect(stats.map((s) => [s.flag, s.count])).toEqual([["EXACT_LOOKUP", 2]]);
    } finally {
      await close();
    }
  });
});
