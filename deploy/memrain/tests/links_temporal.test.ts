import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, graphNeighbors, graphQuery, traverseGraphPage } from "../src/core/links.ts";
import { getLinksPage } from "../src/core/links-read.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`temporal links (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  async function page(slug: string) { await putPage(db.storage, { slug, markdown_body: "Retained page." }); return slug; }
  const snapshot = (slug: string) => db.storage.engine().query("SELECT to_jsonb(l) AS row FROM links l WHERE source_slug=$1 ORDER BY id", [slug]);

  it("uses inclusive starts and exclusive ends while default reads retain every edge", async () => {
    const root = await page("notes/bounds");
    await addLink(db.storage, { source_slug: root, target_slug: "notes/bounded", type: "related_to", valid_from: "2026-11-01", valid_until: "2026-12-01" });
    await addLink(db.storage, { source_slug: root, target_slug: "notes/unbounded", type: "related_to" });
    expect((await graphNeighbors(db.storage, root)).map(r => r.target_slug).sort()).toEqual(["notes/bounded", "notes/unbounded"]);
    expect((await graphNeighbors(db.storage, root))[0]).not.toHaveProperty("valid_from");
    expect((await graphNeighbors(db.storage, root, { status: "all" }))[0]).toHaveProperty("valid_from");
    for (const asOf of ["2026-11-01", "2026-11-30"]) {
      const active = await graphQuery(db.storage, { source_slug: root, type: "related_to", status: "active", asOf });
      expect(active.map(r => r.target_slug).sort()).toEqual(["notes/bounded", "notes/unbounded"]);
      expect(active.find(r => r.target_slug === "notes/bounded")).toMatchObject({ valid_from: "2026-11-01", valid_until: "2026-12-01" });
    }
    expect((await graphNeighbors(db.storage, root, { status: "expired", asOf: "2026-12-01" })).map(r => r.target_slug)).toEqual(["notes/bounded"]);
    expect((await graphNeighbors(db.storage, root, { status: "future", asOf: "2026-10-31" })).map(r => r.target_slug)).toEqual(["notes/bounded"]);
    expect((await graphNeighbors(db.storage, root, { status: "active", asOf: "2026-12-01" })).map(r => r.target_slug)).toEqual(["notes/unbounded"]);
  });
  it("preserves assigned dates and rejects changing or clearing them without updating any other metadata", async () => {
    const source_slug = await page("notes/sticky");
    const edge = { source_slug, target_slug: "notes/target", type: "related_to" };
    await addLink(db.storage, edge);
    await addLink(db.storage, { ...edge, valid_from: "2026-01-01" });
    await addLink(db.storage, { ...edge, valid_until: "2027-01-01" });
    const before = (await snapshot(source_slug)).rows;
    await addLink(db.storage, edge);
    await addLink(db.storage, { ...edge, valid_from: "2026-01-01" });
    expect((await snapshot(source_slug)).rows).toEqual(before);
    await expect(addLink(db.storage, { ...edge, valid_from: "2026-02-01", confidence: 0.3 })).rejects.toThrow("validity");
    await expect(addLink(db.storage, { ...edge, valid_until: null })).rejects.toThrow("validity");
    expect((await snapshot(source_slug)).rows).toEqual(before);
  });
  it("refuses invalid calendars and intervals before creating a row", async () => {
    const source_slug = await page("notes/invalid-date");
    const edge = { source_slug, target_slug: "notes/target", type: "related_to" };
    for (const valid_from of ["2026-02-29", "2026-1-01", "2026-01-01T00:00:00Z"]) await expect(addLink(db.storage, { ...edge, valid_from })).rejects.toThrow();
    await expect(addLink(db.storage, { ...edge, valid_from: "2026-01-01", valid_until: "2026-01-01" })).rejects.toThrow();
    expect((await snapshot(source_slug)).rows).toEqual([]);
    await expect(graphNeighbors(db.storage, source_slug, { asOf: "2026-01-01" })).rejects.toThrow("as_of");
  });
  it("filters every graph hop and both get_links directions before limits", async () => {
    const root = await page("notes/walk");
    const active = await page("notes/walk-active");
    const expired = await page("notes/walk-expired");
    await addLink(db.storage, { source_slug: root, target_slug: active, type: "related_to" });
    await addLink(db.storage, { source_slug: root, target_slug: expired, type: "related_to", valid_until: "2026-01-01" });
    await addLink(db.storage, { source_slug: expired, target_slug: "notes/hidden-descendant", type: "related_to" });
    await addLink(db.storage, { source_slug: active, target_slug: "notes/future-child", type: "related_to", valid_from: "2027-01-01" });
    expect(await traverseGraphPage(db.storage, root, { status: "active", asOf: "2026-11-01", maxDepth: 3, limit: 1 })).toEqual({ hits: [{ slug: active, depth: 1 }], truncated: false });
    const links = await getLinksPage(db.storage, root, { status: "active", asOf: "2026-11-01", limit: 1 });
    expect(links.truncated).toBe(false);
    expect(links.groups.flatMap(g => g.links.map(l => l.target_slug))).toEqual([active]);
    expect((await getLinksPage(db.storage, expired, { status: "active", asOf: "2026-11-01" })).groups.filter(g => g.direction === "inbound")).toEqual([]);
    expect(await traverseGraphPage(db.storage, root, { status: "active", asOf: "2026-11-01", sourceIds: [] })).toEqual({ hits: [], truncated: false });
  });
  it("keeps derived edges separate and preserves tenant, diary and quarantine filters", async () => {
    const root = await page("notes/temporal-filters");
    const visible = await page("notes/temporal-visible");
    const hidden = await page("notes/temporal-hidden");
    const diary = await page("life/diary/temporal-private");
    const journal = "notes/temporal-typed-journal";
    await putPage(db.storage, { slug: journal, type: "\u00a0JOURNAL\u00a0", markdown_body: "Private journal fixture." });
    await db.storage.engine().query("INSERT INTO sources(id,kind,path_prefix) VALUES('temporal-other','other','temporal-other:fixture')");
    for (const target_slug of [visible, hidden, diary, journal]) await addLink(db.storage, { source_slug: root, target_slug, type: "related_to", source_id: "default" });
    await db.storage.engine().query(`INSERT INTO documents(id,source_path,title,source_id,frontmatter)
      VALUES('temporal-hidden-doc',$1,'Hidden','default','{"quarantine":true}'::jsonb)`, [`page://${hidden}`]);
    await db.storage.engine().query(`INSERT INTO links(source_slug,target_slug,type,source_id,link_source,valid_until)
      VALUES($1,$2,'related_to','default','markdown','2026-01-01'),($1,'notes/other-tenant','related_to','temporal-other','manual',NULL)`, [root, visible]);
    await addLink(db.storage, { source_slug: root, target_slug: visible, type: "related_to", source_id: "default", valid_from: "2026-01-01" });
    expect((await db.storage.engine().query<{ valid_until: string }>("SELECT valid_until::text FROM links WHERE source_slug=$1 AND link_source='markdown'", [root])).rows[0]!.valid_until).toBe("2026-01-01");
    const opts = { status: "active" as const, asOf: "2026-11-01", sourceIds: ["default"], excludeDiary: true, limit: 1 };
    expect((await getLinksPage(db.storage, root, opts)).groups.flatMap(g => g.links.map(l => l.target_slug))).toEqual([visible]);
    expect(await traverseGraphPage(db.storage, root, opts)).toEqual({ hits: [{ slug: visible, depth: 1 }], truncated: false });
    expect((await graphNeighbors(db.storage, root, opts)).map(r => r.target_slug)).toEqual([visible]);
    expect((await graphQuery(db.storage, { type: "related_to", source_slug: root, ...opts })).map(r => r.target_slug)).toEqual([visible]);
  });
});
