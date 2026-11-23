import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
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
    k: 10, embedQuery: deterministicEmbedQuery, ...extra,
  });

  it("spends each arm's limit on matching pages", async () => {
    const filters = { types: ["person"], slugPrefix: "people/" };
    const e = db.storage.engine();
    expect(await keywordSearch(e, "alpha", 1, { filters })).toEqual(["b_c0"]);
    expect(await vectorSearch(e, deterministicEmbed("alpha retrieval"), 1, { filters })).toEqual(["b_c0"]);
  });



  it("refuses invalid types and prefixes before search", async () => {
    for (const args of [{ types: [1] }, { types: ["x".repeat(65)] }, { types: Array(21).fill("note") }, { types: ["Note"] }, { slug_prefix: "../" }]) {
      const r = await dispatchTool(db.storage, { name: "search", arguments: { q: "alpha", ...args } });
      expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
    }
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



});
