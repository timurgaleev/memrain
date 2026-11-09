import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { extractMarkdownLinks, syncWikilinksForPage, graphNeighbors } from "../src/core/links.ts";
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`relative links ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("resolves inside the owning source and ignores comments, invalid escapes and root traversal", async () => {
    await registerSource(db.storage.engine(), { id: "tenant", kind: "other", pathPrefix: "tenant" });
    for (const slug of ["projects/alpha/notes/today", "projects/alpha/people/alice-smith"]) {
      await putPage(db.storage, { slug, type: "note", source_id: "tenant" });
    }
    await putPage(db.storage, { slug: "projects/alpha/people/hidden", type: "note" });
    const body = "[Alice](../people/Alice%20Smith.md) [Other](../people/hidden.md) <!-- [[hidden]] -->";
    await syncWikilinksForPage(db.storage, "projects/alpha/notes/today", body, "tenant");
    const links = await graphNeighbors(db.storage, "projects/alpha/notes/today", { sourceIds: ["tenant"] });
    expect(links.map(l => l.target_slug)).toEqual(["projects/alpha/people/alice-smith"]);
    expect(extractMarkdownLinks("[bad](%ZZ.md) [bad](../../outside.md) [url](https%3A%2F%2Fexample.com)", "notes/today")).toEqual([]);
  });
});
