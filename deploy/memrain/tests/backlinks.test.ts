/**
 * Backlinks tests. `wikilink` backlinks read the page `links` table, so they
 * are seeded through pages + the wikilink write path; `tag` backlinks still
 * read entity_mentions, seeded directly so we don't pay for Bedrock embeds.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { findBacklinks } from "../src/core/backlinks.ts";
import { entityId } from "../src/core/entities.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, syncWikilinksForPage } from "../src/core/links.ts";
import { setSlugAlias } from "../src/core/slug-aliases.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

async function seedTags() {
  const db = storage.raw();
  // Two docs, two chunks each.
  await db.exec(`
    INSERT INTO documents (id, source_path, title) VALUES
      ('d1', '/vault/a.md', 'A note'),
      ('d2', '/vault/b.md', 'B note'),
      ('d3', '/vault/c.md', 'C note');
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
      ('d1c0', 'd1', 0, 'mentions #foo once'),
      ('d1c1', 'd1', 1, 'mentions #foo again'),
      ('d2c0', 'd2', 0, 'mentions #foo once'),
      ('d3c0', 'd3', 0, 'mentions only #bar');
  `);
  const fooId = entityId("tag", "foo");
  const barId = entityId("tag", "bar");
  await db.exec(`
    INSERT INTO entities (id, type, name) VALUES
      ('${fooId}', 'tag', 'foo'),
      ('${barId}', 'tag', 'bar');
    INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
      ('d1c0', '${fooId}', 'foo'),
      ('d1c1', '${fooId}', 'foo'),
      ('d2c0', '${fooId}', 'foo'),
      ('d3c0', '${barId}', 'bar');
  `);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-backlinks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findBacklinks (tag entities)", () => {
  beforeEach(seedTags);

  it("returns docs that mention a tag, ordered by mention count", async () => {
    const r = await findBacklinks(storage, "foo", { type: "tag" });
    expect(r.length).toBe(2);
    expect(r[0]!.documentId).toBe("d1"); // 2 mentions
    expect(r[0]!.mentionCount).toBe(2);
    expect(r[1]!.documentId).toBe("d2");
    expect(r[1]!.mentionCount).toBe(1);
  });

  it("returns nothing for an unknown entity", async () => {
    expect(await findBacklinks(storage, "nonexistent", { type: "tag" })).toEqual([]);
  });

  it("respects limit", async () => {
    const r = await findBacklinks(storage, "foo", { type: "tag", limit: 1 });
    expect(r.length).toBe(1);
    expect(r[0]!.documentId).toBe("d1");
  });

  it("rejects out-of-range limit", async () => {
    await expect(findBacklinks(storage, "foo", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(findBacklinks(storage, "foo", { limit: 9999 })).rejects.toThrow(/limit/);
  });
});

describe("findBacklinks (wikilink, page links)", () => {
  const TARGET = "проекты/память";

  async function page(slug: string, title: string, body = "", source_id?: string) {
    await putPage(storage, { slug, type: "note", title, markdown_body: body, ...(source_id ? { source_id } : {}) });
  }

  it("returns every page linking to a Cyrillic target", async () => {
    await page(TARGET, "Память");
    await page("заметки/первая", "Первая", `см. [[Проекты/Память]]`);
    await page("notes/second", "Second", `see [[проекты/память]]`);
    await page("notes/unrelated", "Unrelated", `see [[проекты/другое]]`);
    await syncWikilinksForPage(storage, "заметки/первая", `см. [[Проекты/Память]]`);
    await syncWikilinksForPage(storage, "notes/second", `see [[проекты/память]]`);
    await syncWikilinksForPage(storage, "notes/unrelated", `see [[проекты/другое]]`);

    const r = await findBacklinks(storage, "Проекты/Память");
    expect(r.map((h) => h.sourcePath).sort()).toEqual([
      "page://notes/second",
      "page://заметки/первая",
    ]);
    expect(r.every((h) => h.surfaceForm === TARGET)).toBe(true);
    expect(r.find((h) => h.sourcePath === "page://заметки/первая")!.title).toBe("Первая");
  });

  it("does not collide two long Cyrillic targets sharing a prefix", async () => {
    const stem = "очень-длинное-название-страницы-про-проект-память-и-не-только-";
    await page(`${stem}один`, "Один");
    await page(`${stem}два`, "Два");
    await page("a/linker", "Linker");
    await page("b/linker", "Linker B");
    await addLink(storage, { source_slug: "a/linker", target_slug: `${stem}один`, type: "wikilink" });
    await addLink(storage, { source_slug: "b/linker", target_slug: `${stem}два`, type: "wikilink" });

    const r = await findBacklinks(storage, `${stem}один`);
    expect(r.map((h) => h.sourcePath)).toEqual(["page://a/linker"]);
  });

  it("resolves an alias slug to its canonical page", async () => {
    await page("projects/memory", "Memory");
    await page("notes/one", "One");
    await page("notes/two", "Two");
    await addLink(storage, { source_slug: "notes/one", target_slug: "projects/memory", type: "wikilink" });
    await addLink(storage, { source_slug: "notes/two", target_slug: "projects/memory", type: "mentions" });
    await setSlugAlias(storage.engine(), { alias_slug: "projects/old-memory", canonical_slug: "projects/memory" });

    const r = await findBacklinks(storage, "projects/old-memory");
    expect(r.map((h) => h.sourcePath).sort()).toEqual(["page://notes/one", "page://notes/two"]);
    expect(r.every((h) => h.surfaceForm === "projects/memory")).toBe(true);
  });

  it("never returns a linking page owned by another source", async () => {
    await registerSource(storage.engine(), { id: "tenantA", kind: "vault", pathPrefix: "/tenant-a" });
    await registerSource(storage.engine(), { id: "tenantB", kind: "vault", pathPrefix: "/tenant-b" });
    await page(TARGET, "Память", "", "tenantA");
    await page("a/notes", "A notes", "", "tenantA");
    await page("b/notes", "B notes", "", "tenantB");
    await addLink(storage, { source_slug: "a/notes", target_slug: TARGET, type: "wikilink", source_id: "tenantA" });
    await addLink(storage, { source_slug: "b/notes", target_slug: TARGET, type: "wikilink", source_id: "tenantB" });

    const a = await findBacklinks(storage, TARGET, { sourceIds: ["tenantA"] });
    expect(a.map((h) => h.sourcePath)).toEqual(["page://tenantA/a/notes"]);
    const b = await findBacklinks(storage, TARGET, { sourceIds: ["tenantB"] });
    expect(b.map((h) => h.sourcePath)).toEqual(["page://tenantB/b/notes"]);
    expect(await findBacklinks(storage, TARGET, { sourceIds: [] })).toEqual([]);
    expect((await findBacklinks(storage, TARGET)).length).toBe(2);
  });

  it("skips soft-deleted linking pages", async () => {
    await page("projects/memory", "Memory");
    await page("notes/gone", "Gone");
    await addLink(storage, { source_slug: "notes/gone", target_slug: "projects/memory", type: "wikilink" });
    await storage.engine().query(`UPDATE pages SET deleted_at = NOW() WHERE slug = 'notes/gone'`);
    expect(await findBacklinks(storage, "projects/memory")).toEqual([]);
  });
});
