import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { classifyFact } from "../src/core/facts-classify.ts";
import { clusterFacts, consolidateFactsPhase } from "../src/core/cycle/consolidate-facts.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";

for (const [old, next] of [
  ["Revenue is $5M", "Revenue is $6M"],
  ["Price 44,26 ct/kWh", "Price 45,10 ct/kWh"],
  ["The fee is EUR 12", "The fee is CHF 12"],
  ["Alice accepted the offer", "Alice did not accept the offer"],
  ["Алиса согласна", "Алиса не согласна"],
  ["Alice startet im Januar", "Alice startet im Februar"],
  ["Alice starts in June", "Alice starts in July"],
  ["Launch on 2026-01-01", "Launch on 2026-02-01"],
] as const) describe(`claim divergence: ${old}`, () => {
  for (const mode of ["fast", "fallback", "classifier"] as const) it(`preserves disagreement through ${mode}`, async () => {
    const result = await classifyFact({ fact: next, kind: "fact" }, [{ id: 1, fact: old, kind: "fact", cos: mode === "fast" ? 0.99 : 0.94 }], {
      ...(mode === "classifier" ? { llmFn: async () => ({ text: '{"decision":"duplicate","matched_id":1}', modelId: "test" }) } : {}),
    });
    expect(result.decision).toBe("independent");
  });
});

it("still allows an explicit classifier supersession across a changed amount", async () => {
  expect(await classifyFact({ fact: "Revenue is $6M", kind: "fact" }, [{ id: 1, fact: "Revenue is $5M", kind: "fact", cos: 0.99 }], {
    llmFn: async () => ({ text: '{"decision":"supersede","matched_id":1}', modelId: "test" }),
  })).toMatchObject({ decision: "supersede", supersededId: 1 });
});

it("uses a 0.95 floor for untyped clusters and preserves high-similarity paraphrases", () => {
  const make = (id: number, embedding: number[]) => ({ id, fact: "Alice likes tea", kind: "preference", confidence: 0.8, embedding, written_at: "2025-01-01" });
  expect(clusterFacts([make(1, [1, 0]), make(2, [0.9, Math.sqrt(0.19)])], 0.85)).toHaveLength(2);
  expect(clusterFacts([make(1, [1, 0]), make(2, [1, 0])], 0.85)).toHaveLength(1);
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`claim preservation ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("keeps changed values in the ledger through addFact and consolidation", async () => {
    const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    const ids: number[] = [];
    for (const price of ["44,26", "45,10", "46,20"]) {
      const result = await addFact(db.storage, { entity_slug: "projects/energy", fact: `Energy price is ${price} ct/kWh`, dedup: { embed: async () => vector } });
      expect(result.inserted).toBe(true);
      ids.push(result.id!);
    }
    expect(new Set(ids).size).toBe(3);
    const result = await consolidateFactsPhase(db.storage.engine(), { minOldestAgeMs: 0 });
    expect(result.factsConsolidated).toBe(0);
    expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE entity_slug = 'projects/energy' AND forgotten_at IS NULL AND NOT consolidated")).rows).toHaveLength(3);
  });
});
