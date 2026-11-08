import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { pageSourcePath, pageTruthSourcePath } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { extractAtomsPhase } from "../src/core/synthesis/atoms.ts";
import { proposeTakesPhase } from "../src/core/synthesis/takes.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import { isChronicleEligible } from "../src/core/chronicle/eligibility.ts";
import { runChronicleExtract } from "../src/core/chronicle/extract-events.ts";
import { isFactsExtractionEligible } from "../src/core/facts-extract.ts";

const BODY = "Alice discussed the Paris launch on 2026-03-01 and the team agreed to complete delivery in June. ".repeat(8);
const PREFIXES = ["atoms", "concepts", "patterns", "reflections", "synthesis", "drafts/think", "drift-reports"];
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`synthesis input loops ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "synth-tenant", kind: "vault", pathPrefix: "/synth-tenant" });
    for (const source of ["default", "synth-tenant"]) for (const prefix of [...PREFIXES, "notes"]) {
      const slug = `${prefix}/${source}`;
      await putPage(db.storage, { slug, type: "note", markdown_body: BODY, source_id: source });
      for (const path of [pageSourcePath(slug, source), pageTruthSourcePath(slug, source)]) {
        await db.storage.engine().query("INSERT INTO documents (id, source_path, source_id) VALUES ($1, $1, $2)", [path, source]);
        await db.storage.engine().query("INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $1, 0, $2)", [path, BODY]);
      }
    }
  });
  afterAll(async () => { await db.close(); });
  it("excludes generated body and truth mirrors before atom and take model calls", async () => {
    let atoms = 0, takes = 0;
    const a = await extractAtomsPhase(db.storage.engine(), { maxDocs: 100, llmFn: async () => { atoms++; return { text: "[]", modelId: "test" }; } });
    const t = await proposeTakesPhase(db.storage.engine(), { maxDocs: 100, embed: null, llmFn: async () => { takes++; return { text: "[]", modelId: "test" }; } });
    expect(a.errors).toEqual([]); expect(t.errors).toEqual([]);
    expect(atoms).toBe(4); expect(takes).toBe(4);
  });
  it("excludes generated pages from backfill and direct fact eligibility", async () => {
    let calls = 0;
    const result = await conversationFactsBackfillPhase(db.storage, { maxPages: 100, sonnetFn: async () => {
      calls++;
      return { text: '{"facts":[]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } };
    } });
    expect(result.errors).toEqual([]);
    expect(calls).toBe(2);
    for (const prefix of PREFIXES) expect(isFactsExtractionEligible("note", BODY, `${prefix}/example`).ok).toBe(false);
  });
  it("excludes generated pages from chronicle candidates and direct extraction", async () => {
    for (const prefix of PREFIXES) expect(isChronicleEligible({ type: "meeting", body: BODY, slug: `${prefix}/example` }).ok).toBe(false);
    let calls = 0;
    const r = await runChronicleExtract(db.storage, { slug: "concepts/default", judge: async () => { calls++; return { events: [] }; } });
    expect(calls).toBe(0);
    expect(r.status).toBe("skipped");
  });
});
