import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import { getBrainHotMemoryMeta, invalidateHotMemoryMeta } from "../src/core/hot-memory-meta.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact read collapse ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  let oldHot: string | undefined;
  let latest: number;
  beforeAll(async () => {
    db = await engine.open();
    oldHot = process.env.MEMRAIN_HOT_MEMORY_META;
    process.env.MEMRAIN_HOT_MEMORY_META = "1";
    for (const id of ["collapse-a", "collapse-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (let i = 0; i < 5; i++) {
      const r = await addFact(db.storage, { entity_slug: "people/one", fact: i === 4 ? "  Likes   tea " : "likes tea", source_id: "collapse-a", written_by: `session-${i}`, visibility: "world" });
      latest = r.id!;
    }
    await addFact(db.storage, { entity_slug: "people/one", fact: "likes coffee", source_id: "collapse-a", visibility: "world", confidence: 0.5 });
    await addFact(db.storage, { entity_slug: "people/one", fact: "likes tea", source_id: "collapse-b", visibility: "world" });
    await addFact(db.storage, { entity_slug: "people/one", fact: "likes tea", source_id: "collapse-a", visibility: "private", written_by: "private-writer" });
    await addFact(db.storage, { entity_slug: "people/one", fact: "likes tea", source_id: "collapse-a", visibility: "world", attributed_to: "assistant" });
    await addFact(db.storage, { entity_slug: "people/two", fact: "likes tea", source_id: "collapse-a", visibility: "world" });
  });
  afterAll(async () => {
    if (oldHot === undefined) delete process.env.MEMRAIN_HOT_MEMORY_META;
    else process.env.MEMRAIN_HOT_MEMORY_META = oldHot;
    invalidateHotMemoryMeta();
    await db.close();
  });
  it("collapses after source/visibility filters and before limit, preserving speakers", async () => {
    const rows = await listFacts(db.storage, "people/one", { sourceIds: ["collapse-a"], visibility: ["world"], limit: 3, decay: false });
    expect(rows).toHaveLength(3);
    const user = rows.find(r => r.attributed_to === null && r.fact.toLowerCase().includes("tea"))!;
    expect(user).toMatchObject({ id: latest, source_id: "collapse-a", collapsed_count: 5 });
    expect(rows.find(r => r.attributed_to === "assistant")).toMatchObject({ collapsed_count: 1 });
    expect(rows.some(r => r.fact === "likes coffee")).toBe(true);
    const other = await listFacts(db.storage, "people/one", { sourceIds: ["collapse-b"], visibility: ["world"] });
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ source_id: "collapse-b", collapsed_count: 1 });
    expect(await listFacts(db.storage, null, { sourceIds: [] })).toEqual([]);
  });
  it("keeps distinct entities and the complete audit ledger", async () => {
    const rows = await listFacts(db.storage, null, { sourceIds: ["collapse-a"], visibility: ["world"] });
    expect(rows).toHaveLength(4);
    expect(rows.find(r => r.entity_slug === "people/two")).toMatchObject({ collapsed_count: 1 });
    const audit = await listFacts(db.storage, "people/one", { sourceIds: ["collapse-a"], visibility: ["world"], include_forgotten: true });
    expect(audit).toHaveLength(7);
    expect(audit.every(r => !("collapsed_count" in r))).toBe(true);
  });
  it("collapses hot-memory copies and labels the assistant's claim", async () => {
    invalidateHotMemoryMeta();
    const result = await getBrainHotMemoryMeta(db.storage, { sourceIds: ["collapse-a"], topK: 10 });
    const facts = (result?.brain_hot_memory as { facts: { fact: string; collapsed_count: number }[] }).facts;
    expect(facts).toHaveLength(4);
    expect(facts.some(f => f.fact === "(assistant said) likes tea")).toBe(true);
    expect(facts.filter(f => f.collapsed_count === 6)).toHaveLength(1);
  });
});
