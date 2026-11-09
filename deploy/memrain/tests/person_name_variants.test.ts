import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { makeSlugResolver } from "../src/core/slug-canonicalize.ts";
import { resolveSlugs } from "../src/core/slug-resolve.ts";
import { registerSource } from "../src/core/sources.ts";
import { nameVariantMatch } from "../src/core/name-variants.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

it("does not mistake the first name for a preserved surname or discard conflicting patronymics", () => {
  expect(nameVariantMatch("Alice Smithh", "Alice Smith")).toBeNull();
  expect(nameVariantMatch("Александр Иванович Петров", "Александр Сергеевич Петров")).toBeNull();
  expect(nameVariantMatch("Саша", "Саша Петров")).toBe("weak");
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`person names ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
    for (const [slug, title, source] of [
      ["people/alex", "Александр Петров", "default"],
      ["people/evgeny", "Евгений Сидоров", "default"],
      ["people/evgenia", "Евгения Сидоров", "default"],
      ["people/alice", "Alice Smith", "default"],
      ["people/foreign", "Александр Петров", "other"],
      ["life/diary/hidden", "Александр Петров", "default"],
    ]) await putPage(db.storage, { slug: slug!, title: title!, type: "person", source_id: source! });
    await dispatchTool(db.storage, { name: "page_put", arguments: { slug: "people/held", type: "person", title: "Александр Петров",
      markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d" } }, {});
  });
  afterAll(async () => { await db.close(); });
  it("resolves surname-preserving variants but refuses ambiguous and bare diminutives", async () => {
    const resolver = makeSlugResolver(db.storage, "notes/source", { sourceIds: ["default"] });
    for (const name of ["Петров Александр", "г-н Александр Петров", "А. Петров", "Саша Петров", "Алексндр Петров"]) {
      expect(await resolver.resolve(name)).toEqual({ slug: "people/alex", resolved: true, stage: "name_variant" });
    }
    expect((await resolver.resolve("Женя Сидоров")).resolved).toBe(false);
    expect((await resolver.resolve("Саша")).resolved).toBe(false);
    expect((await resolver.resolve("Dr. Smith Alice")).slug).toBe("people/alice");
    expect((await makeSlugResolver(db.storage, "notes/source", { sourceIds: [] }).resolve("Саша Петров")).resolved).toBe(false);
  });
  it("returns weak read candidates with an explicit variant marker, within scope", async () => {
    const hits = await resolveSlugs(db.storage, "Саша", { sourceIds: ["default"], excludeDiary: true, threshold: 1 });
    expect(hits).toEqual([{ slug: "people/alex", title: "Александр Петров", score: 0.5, variant: true }]);
    expect(await resolveSlugs(db.storage, "Саша", { exact: true, sourceIds: ["default"] })).toEqual([]);
    expect(await resolveSlugs(db.storage, "Саша", { sourceIds: [], threshold: 1 })).toEqual([]);
    const ambiguous = await resolveSlugs(db.storage, "Женя Сидоров", { sourceIds: ["default"], threshold: 1 });
    expect(ambiguous.map(h => h.slug).sort()).toEqual(["people/evgenia", "people/evgeny"]);
  });
  it("refuses to establish uniqueness from a truncated candidate scan", async () => {
    await db.storage.engine().query(`INSERT INTO pages (slug, type, title, content_hash)
      SELECT 'z-padding/' || n, 'person', 'Padding Name', 'fixture' FROM generate_series(1, 2001) n`);
    try {
      const r = await makeSlugResolver(db.storage, "notes/source", { sourceIds: ["default"] }).resolve("Саша Петров");
      expect(r.resolved).toBe(false);
    } finally { await db.storage.engine().query(`DELETE FROM pages WHERE slug LIKE 'z-padding/%'`); }
  });
});
