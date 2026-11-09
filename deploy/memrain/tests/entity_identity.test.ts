import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { entityRecall } from "../src/core/facts.ts";
import { setSlugAlias } from "../src/core/slug-aliases.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { checkPersonNameDuplicates, suggestAliases } from "../src/core/person-identity.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`entity identity ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
    await putPage(db.storage, { slug: "people/alex", type: "person", title: "Александр Петров", compiled_truth: { aliases: ["Саша Петров"] } });
    await putPage(db.storage, { slug: "people/duplicate", type: "person", title: "Саша Петров" });
    await putPage(db.storage, { slug: "people/foreign", type: "person", title: "Александр Петров", source_id: "other" });
    await setSlugAlias(db.storage.engine(), { alias_slug: "people/old", canonical_slug: "people/alex" });
    await setSlugAlias(db.storage.engine(), { alias_slug: "people/foreign-old", canonical_slug: "people/alex", source_id: "other" });
  });
  afterAll(async () => { await db.close(); });
  it("reports declared aliases, incoming redirects and same-source possible duplicates", async () => {
    const r = await entityRecall(db.storage, "people/old", { sourceIds: ["default"] });
    expect((r as any).identity).toEqual({ aliases: ["саша петров"], redirected_from: ["people/old"],
      possible_duplicates: [{ slug: "people/duplicate", title: "Саша Петров" }], truncated: false });
    expect((await entityRecall(db.storage, "people/alex", { sourceIds: ["other"] }) as any).identity).toBeUndefined();
  });
  it("withholds identity on public recall even with an explicit redaction override", async () => {
    const r = await dispatchTool(db.storage, { name: "entity_recall", arguments: { slug: "people/alex", redact_body: false } }, { isPublic: true });
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.identity).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("саша");
  });
  it("diagnoses same-source duplicates without reporting foreign matches or writing aliases", async () => {
    const report = await checkPersonNameDuplicates(db.storage.engine());
    expect(report.status).toBe("warn");
    expect(report.detail).toContain("default:people/alex ~ people/duplicate");
    expect(report.detail).not.toContain("foreign");
    expect(await suggestAliases(db.storage.engine(), { sourceIds: [] })).toEqual({ candidates: [], truncated: false });
    expect((await db.storage.engine().query(`SELECT alias_norm FROM page_aliases ORDER BY alias_norm`)).rows).toEqual([{ alias_norm: "саша петров" }]);
  });
});
