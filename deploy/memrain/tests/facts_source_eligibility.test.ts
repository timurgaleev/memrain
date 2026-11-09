import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { putPage, deletePage, getPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { getBrainHotMemoryMeta, invalidateHotMemoryMeta } from "../src/core/hot-memory-meta.ts";
import { consolidateFactsPhase } from "../src/core/cycle/consolidate-facts.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { findTrajectory } from "../src/core/insights.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact source eligibility ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  let oldHot: string | undefined;
  const held = "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d";
  const page = async (slug: string, body: string, source_id = "default") => {
    await putPage(db.storage, { slug, markdown_body: body, source_id });
    const p = (await getPage(db.storage, slug))!;
    await indexPageIntoSearch(db.storage, p, { embedFn: async (text) => deterministicEmbed(text) });
    return p;
  };
  beforeAll(async () => {
    db = await engine.open();
    oldHot = process.env.MEMRAIN_HOT_MEMORY_META;
    process.env.MEMRAIN_HOT_MEMORY_META = "1";
    await registerSource(db.storage.engine(), { id: "source-a", kind: "vault", pathPrefix: "/source-a" });
    await page("notes/held", held, "source-a");
    await page("notes/deleted", "ordinary text", "source-a");
    await deletePage(db.storage, "notes/deleted");
    await putPage(db.storage, { slug: "source-a/notes/held", markdown_body: "default source owns a colliding bare path" });
    for (const [fact, source_slug, source_id] of [
      ["held-origin", "notes/held", "source-a"],
      ["deleted-origin", "notes/deleted", "source-a"],
      ["unknown-origin", "notes/missing", "source-a"],
      ["foreign-origin", "notes/held", "default"],
      ["colliding-path", "source-a/notes/held", "default"],
    ] as const) await addFact(db.storage, { entity_slug: "people/subject", fact, source_slug, source_id, visibility: "world" });
    const fence = await addFact(db.storage, { entity_slug: "people/subject", fact: "fence-origin", source_slug: "notes/missing", source_id: "source-a" });
    await db.storage.engine().query("UPDATE entity_facts SET source_markdown_slug = 'notes/held' WHERE id = $1", [fence.id]);
  });
  afterAll(async () => {
    if (oldHot === undefined) delete process.env.MEMRAIN_HOT_MEMORY_META;
    else process.env.MEMRAIN_HOT_MEMORY_META = oldHot;
    invalidateHotMemoryMeta();
    await db.close();
  });
  it("filters source state before limit, without borrowing another source's verdict", async () => {
    expect((await listFacts(db.storage, "people/subject", { decay: false })).map(f => f.fact).sort())
      .toEqual(["colliding-path", "foreign-origin", "unknown-origin"]);
    expect((await listFacts(db.storage, "people/subject", { sourceIds: ["source-a"], limit: 1 })).map(f => f.fact)).toEqual(["unknown-origin"]);
    expect(await listFacts(db.storage, null, { sourceIds: [] })).toEqual([]);
    expect(await listFacts(db.storage, "people/subject", { include_forgotten: true })).toHaveLength(6);
  });
  it("rechecks source eligibility even for a cached hot-memory payload", async () => {
    await page("notes/hot", "A normal page", "source-a");
    const fact = await addFact(db.storage, { entity_slug: "people/hot", fact: "cached-then-deleted", source_slug: "notes/hot", source_id: "source-a" });
    invalidateHotMemoryMeta();
    const opts = { sourceIds: ["source-a"], now: Date.now() };
    expect(JSON.stringify(await getBrainHotMemoryMeta(db.storage, opts))).toContain("cached-then-deleted");
    await deletePage(db.storage, "notes/hot");
    const hot = JSON.stringify(await getBrainHotMemoryMeta(db.storage, opts));
    expect(hot).not.toContain("cached-then-deleted");
    expect(hot).not.toContain("held-origin");
    expect((await listFacts(db.storage, "people/hot", { include_forgotten: true }))[0]!.id).toBe(fact.id!);
  });
  it("withholds held facts from the trajectories used by think", async () => {
    const points = await findTrajectory(db.storage, "people/subject", { sourceIds: ["source-a"] });
    expect(JSON.stringify(points)).toContain("unknown-origin");
    expect(JSON.stringify(points)).not.toContain("held-origin");
    expect(JSON.stringify(points)).not.toContain("deleted-origin");
    expect(JSON.stringify(points)).not.toContain("fence-origin");
  });
  it("holds a quarantined fence without deleting its existing projection", async () => {
    const slug = "notes/fence";
    const fence = renderFactsFence([{ rowNum: 1, claim: "Original claim", confidence: 0.8, active: true }]);
    const p = await page(slug, fence);
    await reconcileFactsForPage(db.storage, slug, p.content_hash);
    expect(await listFacts(db.storage, slug)).toHaveLength(1);
    const changed = await page(slug, held + "\n" + renderFactsFence([{ rowNum: 1, claim: "Changed claim", confidence: 0.8, active: true }]));
    expect(await reconcileFactsForPage(db.storage, slug, changed.content_hash)).toMatchObject({ added: 0, removed: 0, skipped: "quarantined" });
    expect(await listFacts(db.storage, slug)).toEqual([]);
    expect((await listFacts(db.storage, slug, { include_forgotten: true })).map(f => f.fact)).toEqual(["Original claim"]);
  });
  it("does not consolidate claims from held origins", async () => {
    for (const fact of ["held first", "held second", "held third"]) {
      const r = await addFact(db.storage, { entity_slug: "people/consolidate", fact, source_slug: "notes/held", source_id: "source-a" });
      await db.storage.engine().query("UPDATE entity_facts SET embedding = $1::vector WHERE id = $2", [JSON.stringify(deterministicEmbed("same")), r.id]);
    }
    const result = await consolidateFactsPhase(db.storage.engine(), { minOldestAgeMs: 0 });
    expect(result.errors).toEqual([]);
    expect(result.takesWritten).toBe(0);
    expect(result.bucketsScanned).toBe(0);
    expect(await listFacts(db.storage, "people/consolidate", { include_forgotten: true })).toHaveLength(3);
  });
});
