import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { replaceFact } from "../src/core/facts-replace.ts";
import { putPage } from "../src/core/pages.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact validity ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });

  for (const [label, start, end, replacement, expected] of [
    ["close", "2025-01-01", null, "2025-03-01", "2025-03-01"],
    ["tighten", "2025-01-01", "2025-04-01", "2025-03-01", "2025-03-01"],
    ["keep-earlier-end", "2025-01-01", "2025-02-01", "2025-03-01", "2025-02-01"],
    ["same-day", "2025-03-01", null, "2025-03-01", null],
    ["backdated", "2025-04-01", null, "2025-03-01", null],
    ["undated-old", null, null, "2025-03-01", null],
    ["undated-new", "2025-01-01", null, null, null],
  ] as const) it(`explicit replacement ${label}`, async () => {
    const entity_slug = `notes/${label}`;
    const old = await addFact(db.storage, { entity_slug, fact: "Old claim", ...(start ? { valid_from: start } : {}) });
    await db.storage.engine().query("UPDATE entity_facts SET valid_until = $2::date WHERE id = $1", [old.id, end]);
    const fresh = await addFact(db.storage, { entity_slug, fact: "New claim", ...(replacement ? { valid_from: replacement } : {}) });
    expect(await replaceFact(db.storage.engine(), old.id!, fresh.id!, ["default"])).toEqual({ replaced: true });
    const row = (await listFacts(db.storage, entity_slug, { include_forgotten: true, decay: false })).find(f => f.id === old.id)!;
    expect(row.valid_until).toBe(expected);
    expect(row.superseded_by).toBe(fresh.id!);
    expect(row.forgotten_at).not.toBeNull();
  });

  it("closes the automatic classifier's replacement at the new validity date", async () => {
    const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    const old = await addFact(db.storage, { entity_slug: "people/automatic", fact: "Was CFO", valid_from: "2025-01-01", dedup: { embed: async () => vector } });
    const fresh = await addFact(db.storage, { entity_slug: "people/automatic", fact: "Now CEO", valid_from: "2025-03-01", dedup: {
      embed: async () => vector, cheapThreshold: 1.1,
      llmFn: async () => ({ text: JSON.stringify({ decision: "supersede", matched_id: old.id }), modelId: "test", usage: { inputTokens: 1, outputTokens: 1 } }),
    } });
    const row = (await listFacts(db.storage, "people/automatic", { include_forgotten: true, decay: false })).find(f => f.id === old.id)!;
    expect(row.superseded_by).toBe(fresh.id!);
    expect(row.valid_until).toBe("2025-03-01");
  });

  it("anchors undated fence claims to the page date, preserving explicit dates and row identity", async () => {
    const slug = "notes/dated-fence";
    const markdown_body = renderFactsFence([
      { rowNum: 1, claim: "Observed on the page date", confidence: 1, active: true },
      { rowNum: 2, claim: "Explicit historical claim", confidence: 1, active: true, validFrom: "2024-12-01" },
    ]);
    const page = await putPage(db.storage, { slug, markdown_body, compiled_truth: { date: "2025-02-17" } });
    await reconcileFactsForPage(db.storage, slug, page.content_hash);
    const rows = await listFacts(db.storage, slug, { decay: false });
    expect(rows.find(f => f.fact.startsWith("Observed"))!.valid_from).toBe("2025-02-17");
    expect(rows.find(f => f.fact.startsWith("Explicit"))!.valid_from).toBe("2024-12-01");
    expect(await reconcileFactsForPage(db.storage, slug, page.content_hash)).toMatchObject({ added: 0, removed: 0, unchanged: 2 });
    expect((await listFacts(db.storage, slug, { decay: false })).map(f => f.id)).toEqual(rows.map(f => f.id));
    const undated = await putPage(db.storage, { slug: "notes/undated-fence", markdown_body });
    await reconcileFactsForPage(db.storage, "notes/undated-fence", undated.content_hash);
    expect((await listFacts(db.storage, "notes/undated-fence", { decay: false })).find(f => f.fact.startsWith("Observed"))!.valid_from).toBeNull();
    const published = await putPage(db.storage, { slug: "notes/published-fence", markdown_body, compiled_truth: { published: "2025-02-18" } });
    await reconcileFactsForPage(db.storage, "notes/published-fence", published.content_hash);
    expect((await listFacts(db.storage, "notes/published-fence", { decay: false })).find(f => f.fact.startsWith("Observed"))!.valid_from).toBe("2025-02-18");
  });
});
