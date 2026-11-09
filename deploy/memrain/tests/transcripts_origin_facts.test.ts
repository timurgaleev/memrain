import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { repairTranscriptOrigin } from "../src/core/transcripts/origin-repair.ts";
import { addFact } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { extractFactsForPage } from "../src/core/facts-extract.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`transcript origin ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("overrides user attribution on agent pages and keeps assistant attribution", async () => {
    const slug = "transcripts/claude-code/agent-p1";
    const body = "Agent: The billing service accepts Euro payments and needs review. Claude: It also supports recurring payments.";
    await putPage(db.storage, { slug, type: "conversation", allowAdHocType: true, markdown_body: body, compiled_truth: { transcript_origin: "agent" } });
    const facts = [
      { fact: "The billing service accepts Euro payments.", attributed_to: "user" },
      { fact: "The billing service supports recurring payments.", attributed_to: "assistant" },
      { fact: "The billing service needs review." },
    ].map(f => ({ ...f, entity: "projects/billing", kind: "observation", confidence: 0.95, notability: "high" }));
    const result = await extractFactsForPage(db.storage, { slug, body, type: "conversation", sonnetFn: async () => ({ text: JSON.stringify({ facts }), modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 10 } }) });
    expect(result.factsWritten).toBe(3);
    const rows = (await db.storage.engine().query<{ fact: string; attributed_to: string }>("SELECT fact, attributed_to FROM entity_facts WHERE source_slug = $1 ORDER BY fact", [slug])).rows;
    expect(rows.map(r => r.attributed_to)).toEqual(["other", "other", "assistant"]);
  });
  it("repairs only proven sessions in the selected source without changing text or rows", async () => {
    await registerSource(db.storage.engine(), { id: "tenant", kind: "transcript", pathPrefix: "tenant/" });
    const evidence = [{ format: "codex", id: "exec-session" }];
    for (const [slug, source, format, id] of [
      ["transcripts/codex/proven-p1", "default", "codex", "exec-session"],
      ["transcripts/codex/foreign-p1", "tenant", "codex", "exec-session"],
      ["transcripts/codex/unknown-p1", "default", "codex", "human-session"],
      ["transcripts/claude-code/different-p1", "default", "claude-code", "exec-session"],
    ]) {
      await putPage(db.storage, { slug: slug!, source_id: source!, markdown_body: "Preserved transcript body", compiled_truth: { format, conversation_id: id } });
      for (const speaker of ["user", "assistant", "other", null]) {
        await db.storage.engine().query(`INSERT INTO entity_facts (entity_slug, fact, source_slug, source_id, attributed_to)
          VALUES ('projects/repair', $1, $2, $3, $4)`, [`Claim from ${speaker}`, slug!, source!, speaker]);
      }
    }
    const before = (await db.storage.engine().query<Record<string, unknown>>(`SELECT * FROM entity_facts WHERE entity_slug = 'projects/repair' ORDER BY id`)).rows;
    const preview = await repairTranscriptOrigin(db.storage, evidence, "default");
    expect(preview).toMatchObject({ applied: false, facts: 2, changed: 0, pages: [{ slug: "transcripts/codex/proven-p1", facts: 2 }] });
    expect((await db.storage.engine().query<Record<string, unknown>>(`SELECT * FROM entity_facts WHERE entity_slug = 'projects/repair' ORDER BY id`)).rows).toEqual(before);
    expect(await repairTranscriptOrigin(db.storage, evidence, "default", true, preview.plan_hash)).toMatchObject({ applied: true, changed: 2 });
    const after = (await db.storage.engine().query<Record<string, unknown>>(`SELECT * FROM entity_facts WHERE entity_slug = 'projects/repair' ORDER BY id`)).rows;
    expect(after).toEqual(before.map(r => r.source_slug === "transcripts/codex/proven-p1" && (r.attributed_to === "user" || r.attributed_to === null) ? { ...r, attributed_to: "other" } : r));
    const again = await repairTranscriptOrigin(db.storage, evidence, "default");
    expect((await repairTranscriptOrigin(db.storage, evidence, "default", true, again.plan_hash)).changed).toBe(0);
  });
  it("rolls back a conflicting relabel instead of deleting either claim", async () => {
    const slug = "transcripts/codex/collision-p1";
    await putPage(db.storage, { slug, markdown_body: "Preserved body", compiled_truth: { format: "codex", conversation_id: "collision" } });
    for (const attributed_to of ["user", "other"] as const) await addFact(db.storage, {
      entity_slug: "projects/collision", fact: "Same claim from two speakers", source_slug: slug, source_chunk_id: "origin-collision", attributed_to,
    });
    const before = (await db.storage.engine().query("SELECT * FROM entity_facts WHERE source_slug = $1 ORDER BY id", [slug])).rows;
    const evidence = [{ format: "codex", id: "collision" }];
    const plan = await repairTranscriptOrigin(db.storage, evidence, "default");
    await expect(repairTranscriptOrigin(db.storage, evidence, "default", true, plan.plan_hash)).rejects.toThrow(/duplicate key/);
    expect((await db.storage.engine().query("SELECT * FROM entity_facts WHERE source_slug = $1 ORDER BY id", [slug])).rows).toEqual(before);
  });

});
