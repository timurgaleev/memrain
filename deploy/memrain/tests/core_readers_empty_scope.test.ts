/**
 * Core readers — an empty source scope reads nothing.
 *
 * `sourceIds: []` is a caller granted no source. Every core reader below used to
 * test `sourceIds && sourceIds.length`, which reads `[]` as "unscoped" and serves
 * the whole brain. Each case seeds tenant 'b' only, calls the reader directly
 * with `[]` (and the ingress sentinel where cheap), and pairs it with an
 * unscoped positive control so an empty result can't pass for a broken fixture.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { NO_SOURCE_SENTINEL } from "../src/core/auth-info.ts";
import { registerSource } from "../src/core/sources.ts";
import { deletePage, getPage, listPages, pageVersions, putPage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { addLink, graphNeighbors, graphQuery, traverseGraph } from "../src/core/links.ts";
import { getLinks, listLinkSources } from "../src/core/links-read.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { getIngestLog, logIngest } from "../src/core/ingest-log.ts";
import { resolveSlugWithAlias, setSlugAlias } from "../src/core/slug-aliases.ts";
import { resolveAliasCandidates, resolveAliasUnique } from "../src/core/page-aliases.ts";
import { makeSlugResolver } from "../src/core/slug-canonicalize.ts";
import { resolveSlugs } from "../src/core/slug-resolve.ts";
import { getChunksForPage, getChunksForSource } from "../src/core/chunks-read.ts";
import { findBacklinks } from "../src/core/backlinks.ts";
import { entityId } from "../src/core/entities.ts";
import { indexPageIntoSearch, pageSourcePath } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60000);

const B = "b";
const SLUG = "people/zeddicus-bee";
const TITLE = "Zeddicus Bee";
const TARGET = "people/zeddicus-target";
const OLD_SLUG = "old/zeddicus";
const PURGE_SLUG = "notes/zeddicus-purge";
const TOKEN = "TenantBOnlyToken-kestrel-7731";
const NONE: string[] = [];
const SENTINEL = [NO_SOURCE_SENTINEL];

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-empty-scope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  await putPage(storage, {
    slug: SLUG, type: "person", title: TITLE, markdown_body: TOKEN, source_id: B,
    compiled_truth: { aliases: ["Zeddo"] },
  });
  // A second write so the page has a version row.
  await putPage(storage, {
    slug: SLUG, type: "person", title: TITLE, markdown_body: `${TOKEN} v2`, source_id: B,
    compiled_truth: { aliases: ["Zeddo"] },
  });
  await putPage(storage, { slug: TARGET, type: "note", title: "Target", markdown_body: "t", source_id: B });
  await addLink(storage, { source_slug: SLUG, target_slug: TARGET, type: "mentions", source_id: B });
  await addTag(storage, SLUG, "btag", B);
  await logIngest(e, { source_type: "vault", summary: TOKEN, source_id: B });
  await setSlugAlias(e, { alias_slug: OLD_SLUG, canonical_slug: SLUG, source_id: B });
  await indexPageIntoSearch(
    storage,
    { slug: SLUG, title: TITLE, markdown_body: TOKEN, source_id: B },
    { embedFn: async (t: string) => deterministicEmbed(t) },
  );

  const fooId = entityId("tag", "zeddicus");
  await storage.raw().exec(`
    INSERT INTO documents (id, source_path, title, source_id) VALUES ('bl-b', '/tenant-b/bl.md', 'BL', 'b');
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('bl-b-c0', 'bl-b', 0, 'see #zeddicus');
    INSERT INTO entities (id, type, name) VALUES ('${fooId}', 'tag', 'zeddicus');
    INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES ('bl-b-c0', '${fooId}', 'zeddicus');
  `);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("pages", () => {
  it("getPage", async () => {
    expect(await getPage(storage, SLUG, NONE)).toBeNull();
    expect(await getPage(storage, SLUG, SENTINEL)).toBeNull();
    expect((await getPage(storage, SLUG))?.slug).toBe(SLUG);
  });

  it("getPage does not follow a redirect under an empty scope", async () => {
    expect(await getPage(storage, OLD_SLUG, NONE)).toBeNull();
    expect((await getPage(storage, OLD_SLUG))?.slug).toBe(SLUG);
  });

  it("listPages", async () => {
    expect(await listPages(storage, { sourceIds: NONE })).toEqual([]);
    expect((await listPages(storage)).map(p => p.slug)).toContain(SLUG);
  });

  it("pageVersions", async () => {
    expect(await pageVersions(storage, SLUG, 20, NONE)).toEqual([]);
    expect((await pageVersions(storage, SLUG)).length).toBeGreaterThan(0);
  });

  it("purgeDeletedPages with [] purges nothing", async () => {
    await putPage(storage, { slug: PURGE_SLUG, type: "note", markdown_body: "p", source_id: B });
    await deletePage(storage, PURGE_SLUG, undefined, B);
    const none = await purgeDeletedPages(storage.engine(), 0, NONE);
    expect(none).toMatchObject({ count: 0, slugs: [], blocked: [], tombstoned: 0, secret_originals: 0 });
    const rows = await storage.engine().query(`SELECT 1 FROM pages WHERE slug = $1`, [PURGE_SLUG]);
    expect(rows.rows.length).toBe(1);
    const all = await purgeDeletedPages(storage.engine(), 0);
    expect(all.slugs).toContain(PURGE_SLUG);
  });
});

describe("links, tags, ingest log", () => {
  it("graphNeighbors", async () => {
    expect(await graphNeighbors(storage, SLUG, { sourceIds: NONE })).toEqual([]);
    expect((await graphNeighbors(storage, SLUG)).length).toBeGreaterThan(0);
  });

  it("graphQuery", async () => {
    expect(await graphQuery(storage, { type: "mentions", source_slug: SLUG, sourceIds: NONE })).toEqual([]);
    expect((await graphQuery(storage, { type: "mentions", source_slug: SLUG })).length).toBeGreaterThan(0);
  });

  it("traverseGraph", async () => {
    const scoped = await traverseGraph(storage, SLUG, { sourceIds: NONE });
    expect(scoped.map(h => h.slug)).not.toContain(TARGET);
    expect((await traverseGraph(storage, SLUG)).map(h => h.slug)).toContain(TARGET);
  });

  it("getLinks", async () => {
    const scoped = await getLinks(storage, SLUG, { sourceIds: NONE });
    expect(JSON.stringify(scoped)).not.toContain(TARGET);
    expect(JSON.stringify(await getLinks(storage, SLUG))).toContain(TARGET);
  });

  it("listLinkSources", async () => {
    const count = (rows: Array<{ type: string; count: number }>) =>
      rows.find(r => r.type === "mentions")?.count ?? 0;
    expect(count(await listLinkSources(storage, NONE))).toBe(0);
    expect(count(await listLinkSources(storage))).toBeGreaterThan(0);
  });

  it("getTags", async () => {
    expect(await getTags(storage, SLUG, NONE)).toEqual([]);
    expect(await getTags(storage, SLUG)).toContain("btag");
  });

  it("getIngestLog", async () => {
    expect(await getIngestLog(storage.engine(), { sourceIds: NONE })).toEqual([]);
    expect(JSON.stringify(await getIngestLog(storage.engine()))).toContain(TOKEN);
  });
});

describe("slug and alias resolution", () => {
  it("resolveSlugWithAlias", async () => {
    expect(await resolveSlugWithAlias(storage, OLD_SLUG, NONE)).toBe(OLD_SLUG);
    expect(await resolveSlugWithAlias(storage, OLD_SLUG)).toBe(SLUG);
  });

  it("resolveAliasUnique / resolveAliasCandidates", async () => {
    expect(await resolveAliasUnique(storage, "zeddo", "", NONE)).toBeNull();
    expect(await resolveAliasCandidates(storage, "zeddo", NONE)).toEqual([]);
    expect(await resolveAliasUnique(storage, "zeddo", "")).toBe(SLUG);
    expect((await resolveAliasCandidates(storage, "zeddo")).map(c => c.slug)).toEqual([SLUG]);
  });

  it("makeSlugResolver", async () => {
    const scoped = await makeSlugResolver(storage, "notes/elsewhere", { sourceIds: NONE }).resolve(TITLE);
    expect(scoped.resolved).toBe(false);
    const open = await makeSlugResolver(storage, "notes/elsewhere").resolve(TITLE);
    expect(open.slug).toBe(SLUG);
  });

  it("resolveSlugs", async () => {
    expect(await resolveSlugs(storage, SLUG, { sourceIds: NONE })).toEqual([]);
    expect(await resolveSlugs(storage, TITLE, { sourceIds: NONE })).toEqual([]);
    expect((await resolveSlugs(storage, SLUG)).map(r => r.slug)).toEqual([SLUG]);
  });

});

describe("chunks and backlinks", () => {
  it("getChunksForSource / getChunksForPage", async () => {
    const path = pageSourcePath(SLUG, B);
    expect(await getChunksForSource(storage, path, NONE)).toEqual([]);
    expect(await getChunksForPage(storage, SLUG, NONE)).toEqual([]);
    expect(JSON.stringify(await getChunksForSource(storage, path))).toContain(TOKEN);
    expect(JSON.stringify(await getChunksForPage(storage, SLUG))).toContain(TOKEN);
  });

  it("findBacklinks", async () => {
    expect(await findBacklinks(storage, TARGET, { sourceIds: NONE })).toEqual([]);
    expect((await findBacklinks(storage, TARGET)).length).toBe(1);
    expect(await findBacklinks(storage, "zeddicus", { type: "tag", sourceIds: NONE })).toEqual([]);
    expect((await findBacklinks(storage, "zeddicus", { type: "tag" })).length).toBe(1);
  });
});
