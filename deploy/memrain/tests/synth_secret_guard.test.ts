/**
 * Synthesis rows are written straight to their tables, not through a page, so
 * each INSERT guards its model-written text itself: a take's claim, a grade's
 * reasoning, a concept's narrative. And take discovery never reads a
 * quarantined document.
 *
 * The fixture token is assembled at run time so no literal credential shape
 * sits in the repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { gradeTakesPhase, proposeTakesPhase } from "../src/core/synthesis/takes.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

const TOKEN = ["gh", "p_"].join("") + "A1b2C3d4".repeat(4) + "Zz9Y";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-secret-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

async function seedDoc(id: string, body: string, frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, title, frontmatter) VALUES ($1, $2, $3, $4::text::jsonb)`, [
    id,
    `/vault/${id}.md`,
    id,
    JSON.stringify(frontmatter),
  ]);
  await engine.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`, [`${id}c0`, id, body]);
}

describe("synthesis INSERT guards", () => {
  it("redacts a credential the extractor lifted into a take's claim", async () => {
    await seedDoc("d1", "Z".repeat(500));
    const r = await proposeTakesPhase(engine, {
      llmFn: fakeLlm(JSON.stringify([{ claim_text: `the deploy key is ${TOKEN}`, kind: "fact", weight: 0.5 }])),
      embed: null,
    });
    expect(r.takesQueued).toBe(1);
    const { rows } = await engine.query<{ claim_text: string }>(`SELECT claim_text FROM synth_takes`);
    expect(rows[0]!.claim_text).not.toContain(TOKEN);
    expect(rows[0]!.claim_text).toContain("[REDACTED:github-token:");
    const audit = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM ingest_log WHERE source_type = 'secret-redacted'`);
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });

  it("redacts a credential the judge quoted into a grade's reasoning", async () => {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ('tk-1', 'd1', 'h', 'v1', 'a claim', 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
    );
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "evidence",
      llmFn: fakeLlm(JSON.stringify({ verdict: "correct", confidence: 0.5, reasoning: `the log shows ${TOKEN}` })),
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ reasoning: string }>(`SELECT reasoning FROM synth_take_grades`);
    expect(rows[0]!.reasoning).not.toContain(TOKEN);
    expect(rows[0]!.reasoning).toContain("[REDACTED:github-token:");
  });

  it("redacts a credential in a concept narrative", async () => {
    for (let i = 0; i < 5; i++) {
      await engine.query(
        `INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id)
         VALUES ($1, 'd1', 'h1', $2, 'body', '["beta"]'::jsonb, 'm')`,
        [`k-${i}`, `atom-${i}`],
      );
    }
    const r = await synthesizeConceptsPhase(engine, { llmFn: fakeLlm(`Beta uses ${TOKEN} to deploy.`) });
    expect(r.conceptsWritten).toBe(1);
    const { rows } = await engine.query<{ narrative: string }>(`SELECT narrative FROM synth_concepts WHERE concept_slug = 'beta'`);
    expect(rows[0]!.narrative).not.toContain(TOKEN);
    expect(rows[0]!.narrative).toContain("[REDACTED:github-token:");
  });
});

describe("take discovery and quarantine", () => {
  it("never sends a quarantined document to the extractor", async () => {
    await seedDoc("held", "Q".repeat(500), { quarantine: { reason: "junk_pattern", detail: "x" } });
    await seedDoc("open", "O".repeat(500));
    const seen: string[] = [];
    const llm: LlmFn = async (input) => {
      seen.push(input.user);
      return { text: "[]", modelId: "fake-nova" };
    };
    const r = await proposeTakesPhase(engine, { llmFn: llm, embed: null });
    expect(r.documentsScanned).toBe(1);
    expect(seen.some((u) => u.includes("Source: held"))).toBe(false);
    expect(seen.some((u) => u.includes("Source: open"))).toBe(true);
  });
});
