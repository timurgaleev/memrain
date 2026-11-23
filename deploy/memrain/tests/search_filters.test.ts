/**
 * Per-call search filters: since/until (content date over
 * COALESCE(effective_date, updated_at), parsed from frontmatter at ingest) +
 * lang / symbol_kind (chunk metadata). Hermetic: deterministic embedder, no
 * Bedrock. Exercises migration 055 + the ingest effective_date parse + the
 * post-hydrate filter + the cache-bypass-when-filtered path.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { resolveDateBoundary } from "../src/core/search/filters.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(25000);

const CONTENT = "alpha beta retrieval signal lookup";
const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-filters-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Old + new markdown docs (content date from frontmatter), same vocab.
  for (const [id, date] of [
    ["doc_old", "2020-01-01"],
    ["doc_new", "2024-06-01"],
  ] as const) {
    await writeDocumentTransaction(
      storage,
      { documentId: id, sourcePath: `/${id}.md`, title: id, frontmatter: { date }, embeddingModel: "deterministic-test" },
      [{ text: CONTENT, entities: [], embedding: deterministicEmbed(CONTENT) }],
    );
  }

  // A doc with a non-midnight content date — guards the TIMESTAMPTZ text
  // rendering ("… 10:00:00+00", space separator) vs an ISO "…T…" bound.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_noon", sourcePath: "/noon.md", title: "noon", frontmatter: { date: "2024-03-15T10:00:00Z" }, embeddingModel: "deterministic-test" },
    [{ text: CONTENT, entities: [], embedding: deterministicEmbed(CONTENT) }],
  );

  // A code chunk carrying language + symbol kind (no frontmatter date).
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_code", sourcePath: "/code.ts", title: "code", frontmatter: {}, embeddingModel: "deterministic-test" },
    [{ text: CONTENT, entities: [], embedding: deterministicEmbed(CONTENT), language: "typescript", symbolType: "function" }],
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function search(opts: Record<string, unknown>): Promise<string[]> {
  const hits = await hybridSearch(storage, "alpha beta retrieval", {
    k: 10,
    embedQuery: deterministicEmbedQuery,
    ...opts,
  });
  return Array.from(new Set(hits.map((h) => toDocId(h.chunkId))));
}

describe("search since/until (content date)", () => {
  it("since keeps only docs dated on/after the bound", async () => {
    const docs = await search({ since: "2023-01-01" });
    expect(docs).toContain("doc_new");
    expect(docs).not.toContain("doc_old");
  });
  it("until keeps only docs dated on/before the bound", async () => {
    const docs = await search({ until: "2022-01-01" });
    expect(docs).toContain("doc_old");
    expect(docs).not.toContain("doc_new");
  });
  it("no date filter returns both markdown docs", async () => {
    const docs = await search({});
    expect(docs).toContain("doc_old");
    expect(docs).toContain("doc_new");
  });
  it("keeps a same-day non-midnight doc against a full-ISO since bound", async () => {
    // doc_noon is 2024-03-15T10:00:00Z; a midnight-of-that-day ISO bound must
    // KEEP it (10:00 >= 00:00) — the epoch compare, not a string compare.
    const docs = await search({ since: "2024-03-15T00:00:00Z", until: "2024-03-16T00:00:00Z" });
    expect(docs).toContain("doc_noon");
    expect(docs).not.toContain("doc_old");
    expect(docs).not.toContain("doc_new");
  });
});


describe("resolveDateBoundary", () => {
  it("relative '7d' resolves to ~7 days back from now", () => {
    const ms = Date.parse(resolveDateBoundary("7d", "since"));
    const expected = Date.now() - 7 * 86_400_000;
    expect(Math.abs(ms - expected)).toBeLessThan(5_000);
  });
  it("relative '2w' resolves to ~14 days back", () => {
    const ms = Date.parse(resolveDateBoundary("2w", "until"));
    const expected = Date.now() - 14 * 86_400_000;
    expect(Math.abs(ms - expected)).toBeLessThan(5_000);
  });
  it("a plain-date until maps to end of that day", () => {
    expect(resolveDateBoundary("2026-01-15", "until")).toBe("2026-01-15T23:59:59.999Z");
  });
  it("a plain-date since pins to UTC midnight (TZ-independent)", () => {
    expect(resolveDateBoundary("2026-01-15", "since")).toBe("2026-01-15T00:00:00.000Z");
  });
  it("full ISO datetimes pass through unchanged on both axes", () => {
    expect(resolveDateBoundary("2024-03-15T10:00:00Z", "since")).toBe("2024-03-15T10:00:00Z");
    expect(resolveDateBoundary("2024-03-15T10:00:00Z", "until")).toBe("2024-03-15T10:00:00Z");
  });
  it("garbage throws instead of silently dropping the bound", () => {
    expect(() => resolveDateBoundary("lol", "since")).toThrow(/Invalid since/);
    expect(() => resolveDateBoundary("lol", "until")).toThrow(/Invalid until/);
  });
  it("a relative bound filters end-to-end", async () => {
    // The dated markdown docs all predate 2025; only doc_code (no frontmatter
    // date → updated_at = ingest time) sits inside a 1-day lookback window.
    expect((await search({ until: "1d" })).length).toBeGreaterThan(0);
    expect(await search({ since: "1d" })).toEqual(["doc_code"]);
  });
});
