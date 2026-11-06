/**
 * Brain identity + purge-deleted-pages — offline (PGLite, no Bedrock).
 *
 * Covers the two deterministic core helpers behind get_brain_identity and
 * purge_deleted_pages. queryRefine's fusion is exercised by the rrf tests
 * (reciprocalRankFusion) — it needs the embedding arm, so it is not run here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { brainIdentity } from "../src/core/identity.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { putPage, deletePage, getPage } from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-identity-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Age a soft-deleted page's deleted_at backwards so the purge cutoff fires. */
async function ageDeletedBy(slug: string, hours: number): Promise<void> {
  await storage
    .engine()
    .query(
      `UPDATE pages SET deleted_at = NOW() - ($2 || ' hours')::interval
        WHERE slug = $1`,
      [slug, String(hours)],
    );
}

describe("brainIdentity", () => {
  it("reports version, engine kind, and zeroed counts on an empty brain", async () => {
    const id = await brainIdentity(storage);
    expect(typeof id.version).toBe("string");
    expect(id.version.length).toBeGreaterThan(0);
    expect(id.engine).toBe("pglite");
    expect(id.documents).toBe(0);
    expect(id.chunks).toBe(0);
    expect(id.embeddings).toBe(0);
    expect(id.pages).toBe(0);
    // Migration 047 seeds the system 'default' tenant (the FK target every
    // content row defaults to), so a fresh brain always has exactly one source.
    expect(id.sources).toBe(1);
    expect(id.created_at).toBeNull();
  });

  it("counts live pages and surfaces the earliest created_at", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await putPage(storage, { slug: "notes/b", type: "note", markdown_body: "y" });
    const id = await brainIdentity(storage);
    expect(id.pages).toBe(2);
    expect(id.created_at).not.toBeNull();
  });

  it("excludes soft-deleted pages from the page count", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await putPage(storage, { slug: "notes/b", type: "note", markdown_body: "y" });
    await deletePage(storage, "notes/b");
    const id = await brainIdentity(storage);
    expect(id.pages).toBe(1);
  });

  it("never surfaces slugs / titles / bodies (counts only)", async () => {
    await putPage(storage, {
      slug: "people/secret",
      type: "person",
      title: "Secret Person",
      markdown_body: "private body",
    });
    const id = await brainIdentity(storage);
    const json = JSON.stringify(id);
    expect(json).not.toContain("people/secret");
    expect(json).not.toContain("Secret Person");
    expect(json).not.toContain("private body");
  });
});

describe("purgeDeletedPages", () => {
  it("reports a page a non-cascading row still references and purges the rest", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "notes/stuck", type: "note", markdown_body: "x" });
    await putPage(storage, { slug: "notes/free", type: "note", markdown_body: "y" });
    await deletePage(storage, "notes/stuck");
    await deletePage(storage, "notes/free");
    await e.exec(`CREATE TABLE purge_hold (slug TEXT REFERENCES pages(slug))`);
    await e.query(`INSERT INTO purge_hold (slug) VALUES ('notes/stuck')`);
    try {
      const r = await purgeDeletedPages(e, 0);
      expect(r.slugs).toEqual(["notes/free"]);
      expect(r.blocked.map((b) => b.slug)).toEqual(["notes/stuck"]);
      expect(await getPage(storage, "notes/stuck", undefined, { includeDeleted: true })).not.toBeNull();
    } finally {
      await e.exec(`DROP TABLE purge_hold`);
    }
  });

  it("is a no-op when nothing is soft-deleted", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    const r = await purgeDeletedPages(storage.engine());
    expect(r.count).toBe(0);
    expect(r.slugs).toEqual([]);
    expect(await getPage(storage, "notes/a")).not.toBeNull();
  });

  it("keeps a soft-deleted page that is younger than the cutoff", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await deletePage(storage, "notes/a"); // deleted_at = NOW(), age 0
    const r = await purgeDeletedPages(storage.engine(), 72);
    expect(r.count).toBe(0);
    // Still present in the table (soft-deleted, not reaped).
    const cnt = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE slug = 'notes/a'",
      );
    expect(cnt.rows[0]?.c).toBe(1);
  });

  it("hard-deletes a page aged past the cutoff and returns its slug", async () => {
    await putPage(storage, { slug: "notes/old", type: "note", markdown_body: "x" });
    await deletePage(storage, "notes/old");
    await ageDeletedBy("notes/old", 100); // older than the 72h cutoff

    const r = await purgeDeletedPages(storage.engine(), 72);
    expect(r.count).toBe(1);
    expect(r.slugs).toEqual(["notes/old"]);

    const cnt = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE slug = 'notes/old'",
      );
    expect(cnt.rows[0]?.c).toBe(0);
  });

  it("cascades to page_versions on hard delete (FK ON DELETE CASCADE)", async () => {
    await putPage(storage, { slug: "notes/old", type: "note", markdown_body: "x" });
    await putPage(storage, { slug: "notes/old", type: "note", markdown_body: "x2" });
    await deletePage(storage, "notes/old");
    await ageDeletedBy("notes/old", 100);

    await purgeDeletedPages(storage.engine(), 72);

    const versions = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM page_versions WHERE slug = 'notes/old'",
      );
    expect(versions.rows[0]?.c).toBe(0);
  });

  it("respects a custom cutoff (smaller window reaps a younger delete)", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await deletePage(storage, "notes/a");
    await ageDeletedBy("notes/a", 2); // 2h old

    expect((await purgeDeletedPages(storage.engine(), 72)).count).toBe(0);
    expect((await purgeDeletedPages(storage.engine(), 1)).count).toBe(1);
  });

  it("defaults to the 720h page TTL when no cutoff is passed", async () => {
    await putPage(storage, { slug: "notes/a", type: "note", markdown_body: "x" });
    await deletePage(storage, "notes/a");
    await ageDeletedBy("notes/a", 721);
    const r = await purgeDeletedPages(storage.engine());
    expect(r.count).toBe(1);
  });
});
