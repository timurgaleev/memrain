import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`canonical concept groups ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("groups equivalent labels once per atom and memoizes the same membership", async () => {
    for (const [key, labels] of [["a", ["Foo-Bar", "foo_bar"]], ["b", ["foo.bar"]]] as const) {
      await db.storage.engine().query("INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id) VALUES ($1, 'source', 'hash', $1, 'body', $2::text::jsonb, 'test')", [key, JSON.stringify(labels)]);
    }
    const first = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: async () => { throw new Error("two atoms must use deterministic synthesis"); } });
    expect(first.errors).toEqual([]);
    expect(first.groupsFound).toBe(1);
    expect((await db.storage.engine().query("SELECT concept_slug, atom_count FROM synth_concepts")).rows).toEqual([{ concept_slug: "foo-bar", atom_count: 2 }]);
    expect((await db.storage.engine().query("SELECT atom_id FROM synth_concept_atoms WHERE concept_slug = 'foo-bar'")).rows).toHaveLength(2);
    const again = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: async () => { throw new Error("unchanged group must not call a model"); } });
    expect(again.groupsUnchanged).toBe(1);
    expect(again.conceptsWritten).toBe(0);
  });
});
