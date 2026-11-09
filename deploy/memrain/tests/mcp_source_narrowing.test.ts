import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { forgetFact } from "../src/core/facts-recall.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`MCP source narrowing (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const embedQuery = async (text: string) => deterministicEmbed(text);
  const authInfo = { clientId: "scope-reader", scopes: ["read"], sourceId: "scope-a", allowedSources: ["scope-a", "scope-b"] } as DispatchOptions["authInfo"];
  beforeAll(async () => {
    db = await open();
    await db.storage.engine().query("INSERT INTO sources(id,kind,path_prefix) VALUES ('scope-a','other','/scope-a/'),('scope-b','other','/scope-b/')");
    for (const source of ["scope-a", "scope-b"]) {
      const page = { slug: `notes/${source}`, title: "Juniper scope", markdown_body: `Juniper scope evidence ${source}.`, source_id: source };
      await putPage(db.storage, page);
      await indexPageIntoSearch(db.storage, page, { embedFn: embedQuery });
      await addFact(db.storage, { entity_slug: page.slug, fact: `Juniper ledger ${source}`, source_id: source, visibility: "world" });
    }
  });
  afterAll(async () => { await db.close(); });
  async function call(tool: string, args: Record<string, unknown>, options: DispatchOptions = { authInfo }) {
    const result = await dispatchTool(db.storage, { name: tool, arguments: args }, { embedQuery, ...options });
    expect(result.isError).toBeFalsy();
    return { body: JSON.parse(result.content[0]!.text), result };
  }
  for (const tool of ["search", "query", "page_list"]) it(`${tool} narrows the grant and keeps omission unchanged`, async () => {
    const args = tool === "page_list" ? { include_body: false } : { q: "Juniper" };
    const narrowed = await call(tool, { ...args, source_ids: ["scope-a"] });
    const rows = narrowed.body.hits ?? narrowed.body.pages;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(narrowed.body)).toContain("scope-a");
    expect(JSON.stringify(narrowed.body)).not.toContain("scope-b");
    const all = await call(tool, args);
    expect(JSON.stringify(all.body)).toContain("scope-b");
  });
  it("binds refine, cached retrieval and supplemental ledger facts to the narrowed source", async () => {
    for (const refine of [undefined, "scope evidence"]) {
      for (const source of ["scope-b", "scope-a", "scope-b"]) {
        const { body } = await call("query", { q: "Juniper", source_ids: [source], ...(refine ? { refine } : {}) });
        expect(body.facts.length).toBeGreaterThan(0);
        expect(JSON.stringify(body)).toContain(source);
        expect(JSON.stringify(body)).not.toContain(source === "scope-a" ? "scope-b" : "scope-a");
      }
    }
  });
  it("treats an empty scope as none without invoking the embedder", async () => {
    let embeddings = 0;
    for (const tool of ["search", "query", "page_list"]) {
      const { body } = await call(tool, { ...(tool === "page_list" ? {} : { q: "Juniper" }), source_ids: [] }, {
        authInfo, embedQuery: async text => { embeddings++; return deterministicEmbed(text); },
      });
      expect(body.hits ?? body.pages).toEqual([]);
      if (tool === "query") expect(body.facts).toEqual([]);
    }
    expect(embeddings).toBe(0);
  });
  it("refuses forbidden and malformed requested sources before reading or spending", async () => {
    const unavailable = { engine() { throw new Error("read before authorization"); } } as unknown as typeof db.storage;
    for (const sources of [["scope-a", "default"], [""], [42], Array(101).fill("scope-a")]) {
      const result = await dispatchTool(unavailable, { name: "query", arguments: { q: "Juniper", source_ids: sources } }, { authInfo });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).not.toContain("read before authorization");
      expect(JSON.parse(result.content[0]!.text).error).toBe(sources.includes("default") ? "permission_denied" : "invalid_params");
    }
  });
  it("narrows operator hot-memory metadata with the result", async () => {
    const prior = process.env.MEMRAIN_HOT_MEMORY_META;
    process.env.MEMRAIN_HOT_MEMORY_META = "1";
    try {
      const { result } = await call("page_list", { source_ids: ["scope-a"], include_body: false }, {});
      expect(JSON.stringify(result._meta)).toContain("scope-a");
      expect(JSON.stringify(result._meta)).not.toContain("scope-b");
      const empty = await call("page_list", { source_ids: [] }, {});
      expect(empty.result._meta).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_HOT_MEMORY_META;
      else process.env.MEMRAIN_HOT_MEMORY_META = prior;
    }
  });
  it("binds a page cursor to its narrowed sources", async () => {
    const broad = await call("page_list", { limit: 1, include_body: false });
    expect(broad.body.next_cursor).toBeString();
    const refused = await dispatchTool(db.storage, { name: "page_list", arguments: {
      limit: 1, include_body: false, cursor: broad.body.next_cursor, source_ids: ["scope-a"],
    } }, { authInfo });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text).error).toBe("invalid_params");
  });
  it("warns on the exact superseded row when a no-op page put reconciles its fence", async () => {
    const slug = "notes/supersede-warning";
    const body = renderFactsFence([{ rowNum: 1, claim: "Old revenue 100", confidence: 1, active: true }]);
    const page = await putPage(db.storage, { slug, markdown_body: body, source_id: "scope-a" });
    await reconcileFactsForPage(db.storage, slug, page.content_hash, "scope-a");
    const row = (await db.storage.engine().query<{ id: number }>("SELECT id FROM entity_facts WHERE source_markdown_slug=$1", [slug])).rows[0]!;
    await forgetFact(db.storage, Number(row.id), { cause: "supersede" });
    const result = await call("page_put", { slug, markdown_body: body, expected_version: 1 }, {
      authInfo: { ...authInfo!, scopes: ["read", "write"] },
    });
    expect(result.body.changed).toBe(false);
    expect(result.body.superseded_rows).toEqual([1]);
  });
  for (const tool of ["page_restore", "page_revert"]) it(`${tool} reports superseded fence rows without reviving them`, async () => {
    const slug = `notes/warning-${tool.replaceAll("_", "-")}`;
    const body = renderFactsFence([{ rowNum: 1, claim: "Old revenue 100", confidence: 1, active: true }]);
    const page = await putPage(db.storage, { slug, markdown_body: body, source_id: "scope-a" });
    await reconcileFactsForPage(db.storage, slug, page.content_hash, "scope-a");
    const row = (await db.storage.engine().query<{ id: number | string }>("SELECT id FROM entity_facts WHERE source_markdown_slug=$1", [slug])).rows[0]!;
    await forgetFact(db.storage, Number(row.id), { cause: "supersede" });
    if (tool === "page_restore") await deletePage(db.storage, slug);
    else await putPage(db.storage, { slug, markdown_body: `${body}\n`, source_id: "scope-a" });
    const result = await call(tool, { slug, ...(tool === "page_revert" ? { version: 1, expected_version: 2 } : {}) }, {
      authInfo: { ...authInfo!, scopes: ["read", "write"] },
    });
    expect(result.body.superseded_rows).toEqual([1]);
    expect((await db.storage.engine().query<{ forgotten_at: unknown }>("SELECT forgotten_at FROM entity_facts WHERE id=$1", [row.id])).rows[0]?.forgotten_at).not.toBeNull();
  });
});
