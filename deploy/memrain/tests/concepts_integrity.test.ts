import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

const MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`concept integrity (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    let calls: number;
    const options = () => ({ storage: db.storage, modelId: MODEL, llmFn: async () => {
      calls += 1;
      return { text: "Concept narrative", modelId: MODEL, usage: { inputTokens: 20, outputTokens: 10 } };
    } });
    async function seed(i: number) {
      await db.storage.engine().query(
        `INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id)
         VALUES ($1, 'd1', 'h1', $1, 'body', '["alpha"]', 'm')`, [`a${i}`],
      );
    }
    beforeEach(async () => {
      db = await open(); calls = 0;
      for (let i = 0; i < 5; i++) await seed(i);
    });
    afterEach(async () => { await db.close(); });

    it("does not pay for or resurrect a deleted concept", async () => {
      await putPage(db.storage, { slug: "concepts/alpha", markdown_body: "old", written_by: "synthesize-concepts" });
      await deletePage(db.storage, "concepts/alpha", "operator");
      const r = await synthesizeConceptsPhase(db.storage.engine(), options());
      expect(calls).toBe(0);
      expect(r.skippedDeleted).toBe(1);
      expect(await getPage(db.storage, "concepts/alpha")).toBeNull();
    });

    it("keeps unchanged groups and their page versions, but regenerates new membership", async () => {
      await synthesizeConceptsPhase(db.storage.engine(), options());
      const before = await db.storage.engine().query("SELECT generated_at FROM synth_concepts");
      const page = await getPage(db.storage, "concepts/alpha", undefined, { withVersion: true });
      const r = await synthesizeConceptsPhase(db.storage.engine(), options());
      expect(calls).toBe(1);
      expect(r.groupsUnchanged).toBe(1);
      expect((await db.storage.engine().query("SELECT generated_at FROM synth_concepts")).rows).toEqual(before.rows);
      expect((await getPage(db.storage, "concepts/alpha", undefined, { withVersion: true }))?.version).toBe(page?.version);
      await seed(5);
      expect((await synthesizeConceptsPhase(db.storage.engine(), options())).conceptsWritten).toBe(1);
      expect(calls).toBe(2);
    });

    it("holds authored concept text when membership changes", async () => {
      await synthesizeConceptsPhase(db.storage.engine(), options());
      await putPage(db.storage, { slug: "concepts/alpha", markdown_body: "human", written_by: "operator" });
      await seed(5);
      expect((await synthesizeConceptsPhase(db.storage.engine(), options())).pagesHeld).toBe(1);
      expect((await getPage(db.storage, "concepts/alpha"))?.markdown_body).toBe("human");
    });

    it("retries a failed page mirror instead of caching its old body", async () => {
      await synthesizeConceptsPhase(db.storage.engine(), options());
      await seed(5);
      const e = db.storage.engine();
      await e.exec(`CREATE FUNCTION reject_concept_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test mirror unavailable'; END $$;
        CREATE TRIGGER reject_concept_update BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION reject_concept_update();`);
      const failed = await synthesizeConceptsPhase(e, options());
      expect(failed.errors.some(s => s.includes("test mirror unavailable"))).toBe(true);
      await e.exec("DROP TRIGGER reject_concept_update ON pages");
      const retry = await synthesizeConceptsPhase(e, options());
      expect(retry.pagesWritten).toBe(1);
      expect((await getPage(db.storage, "concepts/alpha"))?.markdown_body).toContain("Atoms (6)");
    });
  });
}
