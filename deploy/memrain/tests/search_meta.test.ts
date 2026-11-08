/**
 * Search meta — `hybridSearch` reports how a search ran through `onMeta`
 * without changing what it returns.
 *
 * Hermetic: PGLite plus the `embedQuery` seam with deterministic vectors, so
 * the healthy case runs the real vector + keyword + RRF path and the degraded
 * cases are forced by the injected embedder (no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import {
  QueryEmbedDeadlineError,
  type SearchOptions,
} from "../src/core/search/hybrid.ts";
import {
  DEGRADED_REASONS,
  formatDegradedNotice,
  publicSearchMeta,
  type SearchMeta,
} from "../src/core/search/search-meta.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const CORPUS: { id: string; content: string }[] = [
  { id: "doc_zigbee", content: "home assistant zigbee pairing setup guide" },
  { id: "doc_pairing", content: "zigbee pairing troubleshooting for the coordinator stick" },
  { id: "doc_models", content: "bedrock nova model selection titan embeddings" },
];

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-search-meta-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: `/${d.id}.md`,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      [{ text: d.content, entities: [], embedding: deterministicEmbed(d.content) }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function searchWithMeta(
  query: string,
  opts: SearchOptions,
): Promise<{ hits: Awaited<ReturnType<typeof hybridSearch>>; meta: SearchMeta }> {
  const seen: SearchMeta[] = [];
  const hits = await hybridSearch(storage, query, {
    k: 5,
    intent: "topic",
    noExpansion: true,
    ...opts,
    onMeta: (m) => seen.push(m),
  });
  expect(seen.length).toBe(1);
  return { hits, meta: seen[0]! };
}

const failingEmbedder = async (): Promise<number[]> => {
  throw new Error("embedder boom");
};

describe("SearchMeta helpers", () => {
  it("publicSearchMeta keeps only the vector flag and corpus-independent reason codes", () => {
    const pub = publicSearchMeta({
      vectorEnabled: false,
      intent: "topic",
      mode: "conservative",
      cache: "miss",
      degraded: ["embed_timeout", "keyword_zero", "budget_truncated"],
      retrieved: 12,
      returned: 3,
    });
    expect(Object.keys(pub).sort()).toEqual(["degraded", "vectorEnabled"]);
    expect(pub).toEqual({ vectorEnabled: false, degraded: ["embed_timeout"] });
  });

  it("the vocabulary is a closed set of failure and result codes", () => {
    expect([...DEGRADED_REASONS]).toEqual([
      "embed_timeout",
      "vector_arm_failed",
      "keyword_timeout",
      "keyword_arm_failed",
      "title_arm_failed",
      "keyword_zero",
      "expansion_failed",
      "budget_truncated",
      "rerank_skipped",
      "vector_candidates_incomplete",
    ]);
  });

  it("formatDegradedNotice separates nothing-found from degraded", () => {
    expect(formatDegradedNotice({ vectorEnabled: true, degraded: [] })).toBe("no results");
    expect(
      formatDegradedNotice({ vectorEnabled: false, degraded: ["embed_timeout", "keyword_zero"] }),
    ).toBe("no results - vector arm unavailable (embed_timeout); keyword-only search found nothing");
  });
});

describe("hybridSearch onMeta", () => {
  it("a healthy search reports no degradation and leaves the hits unchanged", async () => {
    const opts = { noCache: true, embedQuery: deterministicEmbedQuery };
    const plain = await hybridSearch(storage, "zigbee pairing setup", {
      k: 5,
      intent: "topic",
      noExpansion: true,
      ...opts,
    });
    const { hits, meta } = await searchWithMeta("zigbee pairing setup", opts);
    expect(hits.map((h) => h.chunkId)).toEqual(plain.map((h) => h.chunkId));
    // Recency decay reads the wall clock, so two runs differ past ~1e-10.
    hits.forEach((h, i) => expect(h.score).toBeCloseTo(plain[i]!.score, 8));
    expect(meta.vectorEnabled).toBe(true);
    expect(meta.degraded).toEqual([]);
    expect(meta.cache).toBe("off");
    expect(meta.intent).toBe("topic");
    expect(typeof meta.mode).toBe("string");
    expect(meta.returned).toBe(hits.length);
    expect(meta.retrieved).toBeGreaterThanOrEqual(meta.returned);
  });

  it("a throwing embedder reports vector_arm_failed and still returns keyword hits", async () => {
    const { hits, meta } = await searchWithMeta("zigbee pairing setup", {
      noCache: true,
      embedQuery: failingEmbedder,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(meta.vectorEnabled).toBe(false);
    expect(meta.degraded).toEqual(["vector_arm_failed"]);
  });

  it("an embedder that never settles reports embed_timeout", async () => {
    const { hits, meta } = await searchWithMeta("zigbee pairing setup", {
      noCache: true,
      embedQuery: () => new Promise<number[]>(() => {}),
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(meta.vectorEnabled).toBe(false);
    expect(meta.degraded).toContain("embed_timeout");
    expect(meta.degraded).not.toContain("vector_arm_failed");
  }, 15_000);

  it("an empty degraded result says why instead of looking like an empty brain", async () => {
    const { hits, meta } = await searchWithMeta("zzqx nonexistent phrase", {
      noCache: true,
      embedQuery: async () => {
        throw new QueryEmbedDeadlineError("query embed deadline exceeded");
      },
    });
    expect(hits).toEqual([]);
    expect(meta.degraded).toEqual(["embed_timeout", "keyword_zero"]);
    expect(meta.retrieved).toBe(0);
    expect(meta.returned).toBe(0);
  });

  it("a token budget that drops hits reports budget_truncated", async () => {
    const { meta } = await searchWithMeta("zigbee pairing", {
      noCache: true,
      embedQuery: deterministicEmbedQuery,
      tokenBudget: 1,
    });
    expect(meta.degraded).toEqual(["budget_truncated"]);
    expect(meta.returned).toBe(0);
    expect(meta.retrieved).toBeGreaterThan(0);
  });

  it("a degraded search is never cached; a healthy one is served as a cache hit", async () => {
    const q = "zigbee coordinator stick";
    const degraded = await searchWithMeta(q, { embedQuery: failingEmbedder });
    expect(degraded.meta.cache).toBe("miss");
    expect(degraded.meta.degraded).toEqual(["vector_arm_failed"]);

    const first = await searchWithMeta(q, { embedQuery: deterministicEmbedQuery });
    expect(first.meta.cache).toBe("miss");
    expect(first.meta.degraded).toEqual([]);

    // The cache write is fire-and-forget; poll until the healthy ranking lands.
    let hit: SearchMeta | undefined;
    for (let i = 0; i < 40 && !hit; i++) {
      const r = await searchWithMeta(q, { embedQuery: deterministicEmbedQuery });
      if (r.meta.cache === "hit") {
        hit = r.meta;
        expect(r.hits.map((h) => h.chunkId)).toEqual(first.hits.map((h) => h.chunkId));
      } else {
        await Bun.sleep(25);
      }
    }
    expect(hit).toBeDefined();
    expect(hit!.vectorEnabled).toBe(true);
    expect(hit!.degraded).toEqual([]);
  });

  it("a keyword_zero ranking is never cached, so no hit replays it as clean", async () => {
    const q = "qqvx unmatched wording";
    const first = await searchWithMeta(q, { embedQuery: deterministicEmbedQuery });
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.meta.degraded).toEqual(["keyword_zero"]);
    // Give the fire-and-forget write every chance to land before re-asking.
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(25);
      const again = await searchWithMeta(q, { embedQuery: deterministicEmbedQuery });
      expect(again.meta.cache).toBe("miss");
      expect(again.meta.degraded).toEqual(["keyword_zero"]);
    }
  });

  it("a cache read that throws reports cache error, not a miss", async () => {
    const engine = storage.engine();
    const realQuery = engine.query.bind(engine);
    engine.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM query_cache")) throw new Error("cache table boom");
      return realQuery(sql, params);
    }) as typeof engine.query;
    try {
      const { hits, meta } = await searchWithMeta("zigbee pairing guide", {
        embedQuery: deterministicEmbedQuery,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(meta.cache).toBe("error");
    } finally {
      engine.query = realQuery;
    }
  });

  it("an empty grant reports zero retrieved without embedding", async () => {
    let embedCalls = 0;
    const { hits, meta } = await searchWithMeta("zigbee pairing setup", {
      sourceIds: [],
      embedQuery: async (t) => {
        embedCalls++;
        return deterministicEmbedQuery(t);
      },
    });
    expect(hits).toEqual([]);
    expect(embedCalls).toBe(0);
    expect(meta.retrieved).toBe(0);
    expect(meta.returned).toBe(0);
    expect(meta.degraded).toEqual([]);
  });

  it("a throwing onMeta listener does not break the search", async () => {
    const hits = await hybridSearch(storage, "zigbee pairing setup", {
      k: 5,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
      onMeta: () => {
        throw new Error("listener boom");
      },
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});
