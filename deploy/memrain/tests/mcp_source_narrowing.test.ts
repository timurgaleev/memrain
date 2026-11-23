import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { seedFact } from "./helpers/seed-rows.ts";

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
      await seedFact(db.storage, { entity_slug: page.slug, fact: `Juniper ledger ${source}`, source_id: source, visibility: "world" });
    }
  });
  afterAll(async () => { await db.close(); });
  async function call(tool: string, args: Record<string, unknown>, options: DispatchOptions = { authInfo }) {
    const result = await dispatchTool(db.storage, { name: tool, arguments: args }, { embedQuery, ...options });
    expect(result.isError).toBeFalsy();
    return { body: JSON.parse(result.content[0]!.text), result };
  }
  for (const tool of ["search", "page_list"]) it(`${tool} narrows the grant and keeps omission unchanged`, async () => {
    const args = tool === "page_list" ? { include_body: false } : { q: "Juniper" };
    const narrowed = await call(tool, { ...args, source_ids: ["scope-a"] });
    const rows = narrowed.body.hits ?? narrowed.body.pages;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(narrowed.body)).toContain("scope-a");
    expect(JSON.stringify(narrowed.body)).not.toContain("scope-b");
    const all = await call(tool, args);
    expect(JSON.stringify(all.body)).toContain("scope-b");
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
});
