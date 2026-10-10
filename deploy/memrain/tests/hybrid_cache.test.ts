/**
 * Query cache integration through hybridSearch — the cache-HIT path.
 *
 * A cache hit short-circuits before any Bedrock call (embed / intent), so
 * this exercises the full wiring (key match → clock gate → hydrate → return)
 * with no AWS. We pre-seed the cache, then assert hybridSearch returns the
 * cached ranking, and that advancing the clock invalidates it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import {
  resolveSearchKnobs,
  knobsCacheSuffix,
} from "../src/core/search/hybrid.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";
import {
  putCachedQuery,
  queryCacheKey,
  rankingSignature,
} from "../src/core/search/query-cache.ts";

// The signature hybridSearch computes for a plain `{ k }` call: env-level
// rankingSignature + the resolved per-call knob suffix (knobs-hash parity).
const hybridSig = (opts: Parameters<typeof resolveSearchKnobs>[0] = {}): string =>
  rankingSignature() + knobsCacheSuffix(resolveSearchKnobs(opts));
import {
  bumpDocumentClock,
  currentDocumentClock,
} from "../src/core/generation.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-hybcache-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // Two docs → chunks doc_a_c0, doc_b_c0. Each write bumps the clock.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_a", sourcePath: "/a.md", title: "Alpha", frontmatter: {} },
    [{ text: "alpha content", entities: [] }],
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_b", sourcePath: "/b.md", title: "Beta", frontmatter: {} },
    [{ text: "beta content", entities: [] }],
  );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("hybridSearch query cache (hit path, no Bedrock)", () => {
  it("returns the cached ranking on a hit and skips retrieval", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("my query", 5, undefined, false, hybridSig());
    await putCachedQuery(
      storage.engine(),
      key,
      "my query",
      5,
      "topic",
      ["doc_b_c0", "doc_a_c0"], // cached order: beta first
      clock,
    );

    // No embedText/classifyIntent mock needed: the hit short-circuits first.
    const hits = await hybridSearch(storage, "my query", { k: 5 });
    expect(hits.map((h) => h.chunkId)).toEqual(["doc_b_c0", "doc_a_c0"]);
    expect(hits[0]!.title).toBe("Beta"); // hydrated from live tables
    expect(hits[0]!.intent).toBe("topic");
  });

  it("keys a graph-reranked ranking apart from the default one", async () => {
    // The paid graph rerank reorders the list before it is stored, so a
    // graphRerank call must read/write its own key — otherwise a default caller
    // is served a reranked ordering it never paid for, and vice versa.
    const clock = await currentDocumentClock(storage.engine());
    await putCachedQuery(
      storage.engine(),
      queryCacheKey("split me", 5, undefined, false, hybridSig({ graphRerank: true })),
      "split me",
      5,
      "topic",
      ["doc_b_c0", "doc_a_c0"],
      clock,
    );
    const onHit = await hybridSearch(storage, "split me", { k: 5, graphRerank: true });
    expect(onHit.map((h) => h.chunkId)).toEqual(["doc_b_c0", "doc_a_c0"]);

    // The default caller's key differs, so that row is not its to serve.
    expect(queryCacheKey("split me", 5, undefined, false, hybridSig())).not.toBe(
      queryCacheKey("split me", 5, undefined, false, hybridSig({ graphRerank: true })),
    );
  });

  it("keys each ranking flag apart from the all-off ranking", async () => {
    const { RANKING_FLAG_ENV } = await import("../src/core/search/ranking-flags.ts");
    for (const name of RANKING_FLAG_ENV) delete process.env[name];
    const offSig = rankingSignature();
    const seen = new Set([queryCacheKey("flagged", 5, undefined, false, hybridSig())]);
    try {
      for (const name of RANKING_FLAG_ENV) {
        process.env[name] = "1";
        expect(rankingSignature().startsWith(offSig)).toBe(true);
        seen.add(queryCacheKey("flagged", 5, undefined, false, hybridSig()));
        delete process.env[name];
      }
    } finally {
      for (const name of RANKING_FLAG_ENV) delete process.env[name];
    }
    expect(seen.size).toBe(RANKING_FLAG_ENV.length + 1);
    expect(rankingSignature()).toBe(offSig);
  });

  it("adaptive return-sizing trims the view without poisoning the cache", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("cap me", 5, undefined, false, hybridSig());
    // Cached full order: beta, then alpha. Intent "factual" = single-answer.
    await putCachedQuery(
      storage.engine(),
      key,
      "cap me",
      5,
      "factual",
      ["doc_b_c0", "doc_a_c0"],
      clock,
    );

    // Adaptive ON (entityMax 1) → the returned VIEW is trimmed to 1.
    const capped = await hybridSearch(storage, "cap me", {
      k: 5,
      adaptiveReturn: { enabled: true, entityMax: 1 },
    });
    expect(capped.map((h) => h.chunkId)).toEqual(["doc_b_c0"]);

    // Same query, adaptive OFF → the cache still holds the FULL ordered set:
    // the cap never wrote back, so there is no poisoning across calls.
    const full = await hybridSearch(storage, "cap me", { k: 5 });
    expect(full.map((h) => h.chunkId)).toEqual(["doc_b_c0", "doc_a_c0"]);
  });

  it("grades no confidence from a cache hit's arm-blind evidence", async () => {
    // The hit path stamps default evidence (a title match still reads as
    // exact_title_match, everything else weak_semantic), so a grade derived
    // from it would disagree with the miss that stored the ranking.
    const clock = await currentDocumentClock(storage.engine());
    await putCachedQuery(
      storage.engine(),
      queryCacheKey("Alpha", 5, undefined, false, hybridSig()),
      "Alpha",
      5,
      "entity",
      ["doc_a_c0", "doc_b_c0"],
      clock,
    );
    let meta: SearchMeta | undefined;
    const hits = await hybridSearch(storage, "Alpha", { k: 5, onMeta: (m) => { meta = m; } });
    expect(hits.map((h) => h.chunkId)).toEqual(["doc_a_c0", "doc_b_c0"]);
    expect(meta?.cache).toBe("hit");
    expect(meta?.confidence).toEqual({ grade: "unknown", reason: "cache_hit" });
  });

  it("invalidates the entry hybridSearch would read once the clock advances", async () => {
    const clock = await currentDocumentClock(storage.engine());
    const key = queryCacheKey("stale q", 5, undefined, false);
    await putCachedQuery(storage.engine(), key, "stale q", 5, "topic", ["doc_a_c0"], clock);
    // A new document write bumps the clock → the cached row is now stale.
    await storage.engine().transaction((tx) => bumpDocumentClock(tx));
    const newClock = await currentDocumentClock(storage.engine());
    // hybridSearch reads getCachedQuery(key, currentClock): at the new clock
    // the seeded entry no longer matches, so the cache-hit path is skipped.
    const { getCachedQuery } = await import("../src/core/search/query-cache.ts");
    expect(await getCachedQuery(storage.engine(), key, newClock)).toBeNull();
    expect(await getCachedQuery(storage.engine(), key, clock)).not.toBeNull();
  });
});
