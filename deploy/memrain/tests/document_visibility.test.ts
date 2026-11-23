/**
 * Document soft-delete / archive / quarantine visibility filter (migration 040
 * + core/visibility.ts + destructive-guard.ts).
 *
 * A hidden document must never appear in search; a restore brings it back; the
 * purge phase hard-deletes once past the TTL. All offline (keyword arm needs no
 * Bedrock; det-embed seeds vectors where a row is needed).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import {
  assessDestructiveImpact,
  softDeleteDocuments,
  restoreDocuments,
  archiveSource,
  restoreSource,
  purgeExpiredDocuments,
} from "../src/core/destructive-guard.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

async function seedDoc(
  id: string,
  token: string,
  frontmatter: Record<string, unknown> = {},
): Promise<void> {
  await writeDocumentTransaction(
    storage,
    { documentId: id, sourcePath: `/${id}.md`, title: id, frontmatter, embeddingModel: "deterministic-test" },
    [{ text: `${token} body content here`, entities: [], embedding: deterministicEmbed(token) }],
  );
}

const found = async (token: string): Promise<string[]> =>
  keywordSearch(storage.engine(), token, 10);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-visibility-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seedDoc("doc_visible", "alphavisible");
  await seedDoc("doc_softdel", "bravosoftdel");
  await seedDoc("doc_quar", "charliequar", { quarantine: true });
  await seedDoc("doc_arch", "deltaarch");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("document visibility filter", () => {
  it("a normal document is findable", async () => {
    expect((await found("alphavisible")).length).toBeGreaterThan(0);
  });

  it("a quarantined document is excluded from search", async () => {
    expect((await found("charliequar")).length).toBe(0);
  });

  it("a soft-deleted document drops out of search and restores", async () => {
    expect((await found("bravosoftdel")).length).toBeGreaterThan(0);
    const del = await softDeleteDocuments(storage.engine(), { documentId: "doc_softdel" });
    expect(del.deleted).toBe(1);
    expect((await found("bravosoftdel")).length).toBe(0);

    const res = await restoreDocuments(storage.engine(), { documentId: "doc_softdel" });
    expect(res.restored).toBe(1);
    expect((await found("bravosoftdel")).length).toBeGreaterThan(0);
  });

  it("an archived source drops out of search and restores", async () => {
    await storage
      .engine()
      .query("INSERT INTO sources (id, kind, path_prefix) VALUES ('src-x', 'other', '/x')");
    await storage.engine().query("UPDATE documents SET source_id = 'src-x' WHERE id = 'doc_arch'");
    expect((await found("deltaarch")).length).toBeGreaterThan(0);
    const a = await archiveSource(storage.engine(), "src-x");
    expect(a.archived).toBe(1);
    expect((await found("deltaarch")).length).toBe(0);

    const r = await restoreSource(storage.engine(), "src-x");
    expect(r.restored).toBe(1);
    expect((await found("deltaarch")).length).toBeGreaterThan(0);
  });
});

describe("destructive-guard impact + purge", () => {
  it("assessDestructiveImpact counts live rows for a document", async () => {
    const impact = await assessDestructiveImpact(storage.engine(), { documentId: "doc_visible" });
    expect(impact.documents).toBe(1);
    expect(impact.chunks).toBeGreaterThanOrEqual(1);
    expect(impact.embeddings).toBeGreaterThanOrEqual(1);
  });

  it("purge hard-deletes soft-deleted documents past the TTL", async () => {
    await seedDoc("doc_purgeme", "echopurge");
    await softDeleteDocuments(storage.engine(), { documentId: "doc_purgeme" });
    // ttlHours=0 → immediately past TTL.
    const out = await purgeExpiredDocuments(storage.engine(), 0);
    expect(out.purged_deleted).toBeGreaterThanOrEqual(1);
    const r = await storage
      .engine()
      .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM documents WHERE id = 'doc_purgeme'");
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe("hybrid search never returns a hidden document", () => {
  it("a soft-delete drops a document from both arms of hybrid search", async () => {
    await seedDoc("doc_cacheme", "foxtrotcacheme");
    const opts = { k: 5, embedQuery: deterministicEmbedQuery };
    const first = await hybridSearch(storage, "foxtrotcacheme", opts);
    expect(first.some((h) => h.documentId === "doc_cacheme")).toBe(true);

    await softDeleteDocuments(storage.engine(), { documentId: "doc_cacheme" });

    const second = await hybridSearch(storage, "foxtrotcacheme", opts);
    expect(second.some((h) => h.documentId === "doc_cacheme")).toBe(false);
  });
});
