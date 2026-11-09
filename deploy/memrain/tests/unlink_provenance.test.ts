import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, removeLink, syncWikilinksForPage } from "../src/core/links.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`unlink provenance (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "link-other", kind: "vault", pathPrefix: "/link-other" });
    await putPage(db.storage, { slug: "notes/link-source" });
    await putPage(db.storage, { slug: "notes/link-target" });
  });
  afterAll(async () => { await db.close(); });
  const input = { source_slug: "notes/link-source", target_slug: "notes/link-target", type: "wikilink", source_id: "default" };

  it("keeps manual wikilinks through markdown rewrites and removes only the manual row", async () => {
    await addLink(db.storage, input);
    await syncWikilinksForPage(db.storage, input.source_slug, "[[notes/link-target]]", "default");
    const before = await db.storage.engine().query<{ link_source: string }>("SELECT link_source FROM links WHERE source_slug = $1 ORDER BY link_source", [input.source_slug]);
    expect(before.rows.map(r => r.link_source)).toEqual(["manual", "markdown"]);
    const result = await dispatchTool(db.storage, { name: "unlink", arguments: { source_slug: input.source_slug, target_slug: input.target_slug, type: input.type } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ removed: 1, derived_from_text: [{ type: "wikilink", link_source: "markdown" }] });
    expect(JSON.parse(result.content[0]!.text).message).toContain("page_edit");
    expect((await removeLink(db.storage, input)).removed).toBe(0);
  });

  it("preserves manual rows when the body stops linking and never reports another source's derived rows", async () => {
    await addLink(db.storage, input);
    await syncWikilinksForPage(db.storage, input.source_slug, "No links", "default");
    await db.storage.engine().query("INSERT INTO links (source_slug, target_slug, type, source_id, link_source) VALUES ($1, $2, 'wikilink', 'link-other', 'markdown')", [input.source_slug, input.target_slug]);
    const result = await removeLink(db.storage, input);
    expect(result).toMatchObject({ removed: 1, derived_from_text: [] });
    expect(result.message).toBeUndefined();
    const foreign = await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM links WHERE source_id = 'link-other'");
    expect(foreign.rows[0]!.n).toBe(1);
  });
});
