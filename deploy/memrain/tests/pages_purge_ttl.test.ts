/**
 * Pages wait 30 days (720 h) in the trash before the hard purge; documents
 * keep the 72 h TTL. The result names the TTL it applied.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { purgePhase } from "../src/core/cycle/purge.ts";
import { deletePage, putPage } from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-purge-ttl-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function deletedPage(slug: string, hoursAgo: number): Promise<void> {
  await putPage(storage, { slug, type: "note", markdown_body: `body of ${slug}` });
  await deletePage(storage, slug);
  await storage.engine().query(
    `UPDATE pages SET deleted_at = NOW() - ($2 || ' hours')::interval WHERE slug = $1`,
    [slug, String(hoursAgo)],
  );
}

async function remaining(): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(`SELECT slug FROM pages ORDER BY slug`);
  return r.rows.map((x) => x.slug);
}

describe("page purge TTL", () => {
  it("the purge phase keeps a page deleted 100 hours ago and reaps one deleted 721 hours ago", async () => {
    await deletedPage("notes/young", 100);
    await deletedPage("notes/old", 721);
    await purgePhase(storage.engine());
    expect(await remaining()).toEqual(["notes/young"]);
  });

  it("documents still purge at 72 hours", async () => {
    await storage.engine().query(
      `INSERT INTO documents (id, source_path, title, deleted_at)
       VALUES ('doc-old', '/v/old.md', 'old', NOW() - interval '100 hours')`,
    );
    const r = await purgePhase(storage.engine());
    expect(r.purged_documents_deleted).toBe(1);
    const left = await storage.engine().query(`SELECT 1 FROM documents WHERE id = 'doc-old'`);
    expect(left.rows).toHaveLength(0);
  });

  it("purgeDeletedPages reports the TTL it applied", async () => {
    expect((await purgeDeletedPages(storage.engine())).ttl_hours).toBe(720);
    expect((await purgeDeletedPages(storage.engine(), 0)).ttl_hours).toBe(0);
    expect((await purgeDeletedPages(storage.engine(), 5, undefined, { dryRun: true })).ttl_hours).toBe(5);
  });
});
