import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { CONCEPT_PROMPT_VERSION, synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";

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

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`deterministic concept pages ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeEach(async () => { db = await engine.open(); });
  afterEach(async () => { await db.close(); });
  const noModel = async (): Promise<never> => { throw new Error("a small group must use deterministic synthesis"); };
  const atoms = async (rows: ReadonlyArray<readonly [string, readonly string[]]>) => {
    for (const [key, labels] of rows) {
      await db.storage.engine().query("INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id) VALUES ($1, 'source', 'hash', $1, 'body', $2::text::jsonb, 'test')", [key, JSON.stringify(labels)]);
    }
  };
  const page = async (slug: string) => (await db.storage.engine().query<{ content_hash: string; markdown_body: string }>(
    "SELECT content_hash, markdown_body FROM pages WHERE slug = $1", [slug])).rows[0];

  it("names its concept, so concepts tagged on the same atoms are not byte-identical twins", async () => {
    await atoms([["first insight", ["astro", "react-islands"]], ["second insight", ["astro", "react-islands"]]]);
    const r = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: noModel, storage: db.storage });
    expect(r.errors).toEqual([]);
    const astro = await page("concepts/astro");
    const islands = await page("concepts/react-islands");
    expect(astro!.content_hash).not.toBe(islands!.content_hash);
    expect(astro!.markdown_body).toContain("\"astro\"");
    expect(islands!.markdown_body).toContain("\"react islands\"");
  });

  it("re-renders a page memoized under the earlier deterministic text once, with no model call", async () => {
    await atoms([["first insight", ["astro"]], ["second insight", ["astro"]]]);
    await synthesizeConceptsPhase(db.storage.engine(), { llmFn: noModel, storage: db.storage });
    const ids = (await db.storage.engine().query<{ id: number }>("SELECT id FROM synth_atoms ORDER BY id")).rows.map(r => Number(r.id));
    const earlier = createHash("sha256").update(`${ids.join(",")}|${CONCEPT_PROMPT_VERSION}|deterministic`).digest("hex");
    await db.storage.engine().query("UPDATE synth_concepts SET member_hash = $1 WHERE concept_slug = 'astro'", [earlier]);
    const again = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: noModel, storage: db.storage });
    expect(again.conceptsWritten).toBe(1);
    expect(again.groupsUnchanged).toBe(0);
    const third = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: noModel, storage: db.storage });
    expect(third.groupsUnchanged).toBe(1);
    expect(third.conceptsWritten).toBe(0);
  });

  it("mints no hub for a placeholder concept tag", async () => {
    await atoms([["first insight", ["organization", "astro"]], ["second insight", ["organization", "astro"]]]);
    const r = await synthesizeConceptsPhase(db.storage.engine(), { llmFn: noModel, storage: db.storage });
    expect(r.errors).toEqual([]);
    expect((await db.storage.engine().query("SELECT concept_slug FROM synth_concepts ORDER BY concept_slug")).rows).toEqual([{ concept_slug: "astro" }]);
    expect(await page("concepts/organization")).toBeUndefined();
    expect(await page("concepts/astro")).toBeDefined();
  });
});
