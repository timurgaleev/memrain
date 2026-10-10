/**
 * Graph reads hide an edge whose endpoint is a hidden page — soft-deleted, or
 * whose body mirror is archived or quarantined — and keep every endpoint that
 * has no page at all: a dangling wikilink target, and a name only a vault note
 * answers to. The live corpus links mostly to such pageless names, so the
 * fixture carries a vault document under one of them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addLink, graphNeighbors, graphQuery, traverseGraph } from "../src/core/links.ts";
import { getLinks } from "../src/core/links-read.ts";
import { relationalRecall } from "../src/core/search/relational-recall.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-links-vis-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const slug of ["people/alice", "companies/acme", "companies/gone", "companies/held", "companies/shelved", "companies/unmirrored"]) {
    await putPage(storage, { slug, title: slug, markdown_body: `about ${slug}` });
  }
  await deletePage(storage, "companies/gone");
  // Body mirrors: one quarantined, one archived, one fine. companies/unmirrored has none.
  await storage.engine().exec(`
    INSERT INTO documents (id, source_path, title, frontmatter, archived) VALUES
      ('m-acme', 'page://companies/acme', 'acme', '{}'::jsonb, false),
      ('m-held', 'page://companies/held', 'held', '{"quarantine": {"reason": "junk"}}'::jsonb, false),
      ('m-shelved', 'page://companies/shelved', 'shelved', '{}'::jsonb, true),
      ('v-1', '/vault/notes/offsite-2026.md', 'Offsite 2026', '{}'::jsonb, false);
  `);
  for (const target of [
    "companies/acme", "companies/gone", "companies/held", "companies/shelved",
    "companies/unmirrored", "notes/offsite-2026", "someone-unknown",
  ]) {
    await addLink(storage, { source_slug: "people/alice", target_slug: target, type: "works_at", allowAdHocType: true });
  }
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const VISIBLE = ["companies/acme", "companies/unmirrored", "notes/offsite-2026", "someone-unknown"].sort();

describe("graph reads hide hidden pages and keep pageless endpoints", () => {
  it("graphNeighbors", async () => {
    const rows = await graphNeighbors(storage, "people/alice", { direction: "outbound" });
    expect(rows.map((r) => r.target_slug).sort()).toEqual(VISIBLE);
  });

  it("graphQuery", async () => {
    const rows = await graphQuery(storage, { type: "works_at", source_slug: "people/alice" });
    expect(rows.map((r) => r.target_slug).sort()).toEqual(VISIBLE);
  });

  it("traverseGraph", async () => {
    const hits = await traverseGraph(storage, "people/alice", { direction: "outbound", maxDepth: 1 });
    expect(hits.map((h) => h.slug).sort()).toEqual(VISIBLE);
  });

  it("getLinks", async () => {
    const groups = await getLinks(storage, "people/alice");
    const targets = groups.flatMap((g) => g.links.map((l) => l.target_slug)).sort();
    expect(targets).toEqual(VISIBLE);
  });

  it("an inbound read of a hidden page returns nothing; of a pageless name, its edge", async () => {
    expect(await graphNeighbors(storage, "companies/held", { direction: "inbound" })).toEqual([]);
    const toVault = await graphNeighbors(storage, "notes/offsite-2026", { direction: "inbound" });
    expect(toVault.map((r) => r.source_slug)).toEqual(["people/alice"]);
  });

  it("a soft-deleted source hides its outbound edges", async () => {
    await deletePage(storage, "people/alice");
    expect(await graphNeighbors(storage, "people/alice")).toEqual([]);
    expect(await getLinks(storage, "people/alice")).toEqual([]);
  });

  it("relationalRecall fans out over the same visible edges", async () => {
    const out = await relationalRecall(storage, "who works at acme");
    expect(out.map((r) => r.slug)).toEqual(["people/alice"]);
    // The held company still has its page, so the seed resolves, but the edge is hidden.
    expect(await relationalRecall(storage, "who works at held")).toEqual([]);
  });
});
