/**
 * An explicit purge of named pages leaves a text-free tombstone: the content
 * hash of the page and of each version it kept. A write of that content, under
 * any slug of the source, is refused, so a resync or a re-import cannot bring
 * the purged text back. The TTL reaper leaves none, and unpurge clears them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Storage } from "../src/core/storage.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, PurgedContentError, putPage } from "../src/core/pages.ts";
import { clearPageTombstones, purgeDeletedPages } from "../src/core/pages-purge.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let storage: Storage;

async function deletedPage(slug: string, ...bodies: string[]): Promise<void> {
  for (const body of bodies) await putPage(storage, { slug, markdown_body: body });
  await deletePage(storage, slug);
  await storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`, [slug]);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(name, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    db = await open();
    storage = db.storage;
  });
  afterEach(async () => { await db.close(); });

describe("page purge tombstones", () => {
  it("refuses the purged text under the same slug, another slug, and an older version's text", async () => {
    await deletedPage("notes/secret", "first draft of the secret\n", "final secret text\n");
    const r = await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/secret"], tombstone: true });
    expect(r.count).toBe(1);
    expect(r.tombstoned).toBe(2);
    await expect(putPage(storage, { slug: "notes/secret", markdown_body: "final secret text\n" })).rejects.toBeInstanceOf(PurgedContentError);
    await expect(putPage(storage, { slug: "notes/copy", markdown_body: "final secret text\n" })).rejects.toBeInstanceOf(PurgedContentError);
    await expect(putPage(storage, { slug: "notes/copy", markdown_body: "first draft of the secret\n" })).rejects.toBeInstanceOf(PurgedContentError);
    const fresh = await putPage(storage, { slug: "notes/secret", markdown_body: "something new\n" });
    expect(fresh.created).toBe(true);
  });

  it("does not refuse the same text in another source", async () => {
    await deletedPage("notes/secret", "final secret text\n");
    await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/secret"], tombstone: true });
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('other', 'other', 'other/') ON CONFLICT DO NOTHING`);
    const r = await putPage(storage, { slug: "notes/elsewhere", markdown_body: "final secret text\n", source_id: "other" });
    expect(r.created).toBe(true);
  });

  it("the TTL reaper leaves no tombstone", async () => {
    await deletedPage("notes/old", "old text\n");
    const r = await purgeDeletedPages(storage.engine());
    expect(r.count).toBe(1);
    expect(r.tombstoned).toBe(0);
    expect((await putPage(storage, { slug: "notes/old", markdown_body: "old text\n" })).created).toBe(true);
  });

  it("unpurge clears a page's tombstones so its text can be written again", async () => {
    await deletedPage("notes/secret", "final secret text\n");
    await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/secret"], tombstone: true });
    expect(await clearPageTombstones(storage.engine(), "notes/secret", "default")).toBe(1);
    expect((await putPage(storage, { slug: "notes/secret", markdown_body: "final secret text\n" })).created).toBe(true);
  });

  it("unpurging one page keeps another page purged with the same text protected", async () => {
    await deletedPage("notes/one", "shared text\n");
    await deletedPage("notes/two", "shared text\n");
    await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/one"], tombstone: true });
    await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/two"], tombstone: true });
    expect(await clearPageTombstones(storage.engine(), "notes/two", "default")).toBe(1);
    await expect(putPage(storage, { slug: "notes/three", markdown_body: "shared text\n" })).rejects.toBeInstanceOf(PurgedContentError);
  });

  it("purge_deleted_pages with named slugs tombstones them", async () => {
    await deletedPage("notes/a", "text of a\n");
    const r = JSON.parse((await dispatchTool(storage, { name: "purge_deleted_pages", arguments: { slugs: ["notes/a"] } })).content[0]!.text);
    expect(r.tombstoned).toBe(1);
    await expect(putPage(storage, { slug: "notes/a", markdown_body: "text of a\n" })).rejects.toBeInstanceOf(PurgedContentError);
  });
});
});
