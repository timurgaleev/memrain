import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import { titleArmChunkIds } from "../src/core/search/title-arm.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { applyAliasHop } from "../src/core/search/alias-hop.ts";
import { relationalArmChunkIds } from "../src/core/search/relational-recall.ts";
import { addLink } from "../src/core/links.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`search page filters (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "filters-b", kind: "vault", pathPrefix: "/filters-b" });
    for (const [id, slug, type, source] of [
      ["a", "notes/noise", "note", "default"], ["b", "people/match", "person", "default"],
      ["c", "people/foreign", "company", "filters-b"],
    ]) {
      await putPage(db.storage, { slug: slug!, type: type!, source_id: source!, markdown_body: "alpha retrieval",
        compiled_truth: { aliases: [id === "a" ? "noisealias" : "matchedalias"] } });
      await writeDocumentTransaction(db.storage, { documentId: id!, sourcePath: `page://${source === "default" ? "" : source + "/"}${slug}`,
        title: "Shared Title", frontmatter: {}, sourceId: source!, embeddingModel: "deterministic-test" },
      [{ text: "alpha retrieval", entities: [], embedding: deterministicEmbed("alpha retrieval") }]);
    }
  });
  afterAll(async () => { await db.close(); });
  const search = (q: string, extra = {}) => hybridSearch(db.storage, q, {
    k: 10, intent: "topic", noCache: true, noExpansion: true, rerank: false, embedQuery: deterministicEmbedQuery, ...extra,
  });

  it("spends each arm's limit on matching pages", async () => {
    const filters = { types: ["person"], slugPrefix: "people/" };
    const e = db.storage.engine();
    expect(await keywordSearch(e, "alpha", 1, { filters })).toEqual(["b_c0"]);
    expect(await vectorSearch(e, deterministicEmbed("alpha retrieval"), 1, { filters })).toEqual(["b_c0"]);
    expect(await titleArmChunkIds(e, "Shared Title", { filters, limit: 1 })).toEqual(["b_c0"]);
  });

  it("keeps page ownership in the predicate and cannot reinject a filtered alias", async () => {
    expect((await search("alpha", { types: ["company"], sourceIds: ["default"] })).length).toBe(0);
    expect((await search("alpha", { types: ["company"], sourceIds: ["filters-b"] })).map(h => h.documentId)).toEqual(["c"]);
    expect((await search("noisealias", { types: ["person"] })).every(h => h.documentId === "b")).toBe(true);
    expect(await search("alpha", { slugPrefix: "missing/" })).toEqual([]);
    setSystemTime(new Date("2026-11-10T12:00:00Z"));
    try {
      expect(await search("alpha", { types: [], slugPrefix: "" })).toEqual(await search("alpha"));
    } finally { setSystemTime(); }
  });

  it("forwards filters through MCP search, query and refine and scopes unknown-type hints", async () => {
    const opts = { embedQuery: deterministicEmbedQuery,
      authInfo: { token: "test", clientId: "test", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false } };
    for (const [name, extra] of [["search", {}], ["query", {}], ["query", { refine: "retrieval" }]] as const) {
      const r = await dispatchTool(db.storage, { name, arguments: { q: "alpha", types: ["person"], slug_prefix: "people/", ...extra } }, opts);
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.content[0]!.text).hits.map((h: { documentId: string }) => h.documentId)).toEqual(["b"]);
      const unknown = await dispatchTool(db.storage, { name, arguments: { q: "alpha", types: ["company"], ...extra } }, opts);
      const data = JSON.parse(unknown.content[0]!.text);
      expect(data.notice).toBe("unknown_page_types");
      expect(data.available_types).toEqual(["note", "person"]);
    }
  });

  it("refuses invalid types and prefixes before search", async () => {
    for (const args of [{ types: [1] }, { types: ["x".repeat(65)] }, { types: Array(21).fill("note") }, { types: ["Note"] }, { slug_prefix: "../" }]) {
      const r = await dispatchTool(db.storage, { name: "search", arguments: { q: "alpha", ...args } });
      expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
    }
  });

  it("filters alias claimants before the injection cap", async () => {
    for (let i = 0; i < 3; i++) await putPage(db.storage, { slug: `notes/alias-${i}`, markdown_body: "No mirror", compiled_truth: { aliases: ["matchedalias"] } });
    const hits = await applyAliasHop([], db.storage, "matchedalias", "topic", ["default"], { filters: { types: ["person"] } });
    expect(hits.map(h => h.documentId)).toEqual(["b"]);
  });

  it("includes truth/file twins but rejects a document with mismatched ownership", async () => {
    for (const [id, sourcePath, sourceId] of [
      ["truth", "page-truth://people/match", "default"],
      ["file", "people/match.md", "default"],
      ["wrong-owner", "page://people/match", "filters-b"],
    ]) {
      // source_path is globally unique; the wrong-owner case uses the truth path's tenant form.
      const path = id === "wrong-owner" ? "page://filters-b/people/match" : sourcePath!;
      await writeDocumentTransaction(db.storage, { documentId: id!, sourcePath: path, sourceId: sourceId!,
        title: "Twin", frontmatter: {}, embeddingModel: "deterministic-test" },
      [{ text: "twin-probe", entities: [], embedding: deterministicEmbed("twin-probe") }]);
    }
    expect((await keywordSearch(db.storage.engine(), "twin-probe", 10, { filters: { types: ["person"], slugPrefix: "people/match" } })).sort()).toEqual(["file_c0", "truth_c0"]);
  });

  it("filters relational candidates before the arm limit", async () => {
    await putPage(db.storage, { slug: "companies/acme", title: "Acme", type: "company" });
    for (const source_slug of ["people/match", "notes/noise"]) await addLink(db.storage, { source_slug, target_slug: "companies/acme", type: "works_at" });
    expect(await relationalArmChunkIds(db.storage, "who works at acme", { limit: 1, filters: { types: ["person"] } })).toEqual(["b_c0"]);
  });

  it("hydrates tenant-qualified relational mirrors without accepting mismatched page ownership", async () => {
    await putPage(db.storage, { slug: "companies/tenantco", title: "Tenantco", source_id: "filters-b" });
    await addLink(db.storage, { source_slug: "people/foreign", target_slug: "companies/tenantco", type: "works_at", source_id: "filters-b" });
    await db.storage.engine().query("INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('notes/noise', 'companies/tenantco', 'works_at', 'filters-b')");
    await writeDocumentTransaction(db.storage, { documentId: "bad-tenant-mirror", sourcePath: "page://filters-b/notes/noise", sourceId: "filters-b",
      title: "Wrong owner", frontmatter: {}, embeddingModel: "deterministic-test" },
    [{ text: "foreign mirror", entities: [], embedding: deterministicEmbed("foreign mirror") }]);
    expect(await relationalArmChunkIds(db.storage, "who works at tenantco", { sourceIds: ["filters-b"] })).toEqual(["c_c0"]);
    expect(await relationalArmChunkIds(db.storage, "who works at tenantco", { sourceIds: ["default"] })).toEqual([]);
  });

  it("keeps legacy unowned mirrors available only to an unscoped caller", async () => {
    await putPage(db.storage, { slug: "companies/legacyco", title: "Legacyco" });
    await putPage(db.storage, { slug: "people/legacy" });
    await addLink(db.storage, { source_slug: "people/legacy", target_slug: "companies/legacyco", type: "works_at" });
    await writeDocumentTransaction(db.storage, { documentId: "legacy-mirror", sourcePath: "page://people/legacy",
      title: "Legacy", frontmatter: {}, embeddingModel: "deterministic-test" },
    [{ text: "legacy mirror", entities: [], embedding: deterministicEmbed("legacy mirror") }]);
    expect(await relationalArmChunkIds(db.storage, "who works at legacyco")).toEqual(["legacy-mirror_c0"]);
    expect(await relationalArmChunkIds(db.storage, "who works at legacyco", { sourceIds: ["default"] })).toEqual([]);
  });
});
