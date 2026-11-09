/**
 * synthesize_concepts phase tests — hermetic, MOCKED llmFn (no Bedrock).
 * Verifies clustering/tiering, provenance links, idempotent upsert, fail-open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import { BudgetTracker } from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-concepts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let atomCounter = 0;
async function seedAtom(concepts: string[], title = `atom-${atomCounter}`): Promise<number> {
  atomCounter += 1;
  const key = `k-${atomCounter}`;
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id)
     VALUES ($1, 'd1', 'h1', $2, 'body', $3::jsonb, 'm') RETURNING id`,
    [key, title, JSON.stringify(concepts)],
  );
  return Number(rows[0]?.id);
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });
const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

describe("synthesizeConceptsPhase", () => {
  for (const stopReason of ["max_tokens", "model_context_window_exceeded", "guardrail_intervened", "content_filtered", "malformed_model_output", "malformed_tool_use"]) {
    it(`keeps deterministic narrative when the model stops with ${stopReason}`, async () => {
      for (let i = 0; i < 5; i++) await seedAtom(["incomplete"]);
      const budget = new BudgetTracker(1, "test-incomplete-concept");
      await synthesizeConceptsPhase(engine, { budget, modelId: HAIKU, llmFn: async () => ({ text: "UNUSABLE_PARTIAL_NARRATIVE", stopReason, modelId: HAIKU, usage: { inputTokens: 100, outputTokens: 10 } }) });
      const rows = await engine.query<{ narrative: string }>("SELECT narrative FROM synth_concepts WHERE concept_slug = 'incomplete'");
      expect(rows.rows[0]!.narrative).toContain("T2 concept");
      expect(rows.rows[0]!.narrative).not.toContain("UNUSABLE_PARTIAL_NARRATIVE");
      expect(budget.totalSpent()).toBeGreaterThan(0);
    });
  }
  it("groups atoms, tiers by count, writes concept + provenance", async () => {
    const a1 = await seedAtom(["alpha"]);
    const a2 = await seedAtom(["alpha"]);
    await seedAtom(["lonely"]); // count 1 → below threshold, skipped

    const r = await synthesizeConceptsPhase(engine, {
      llmFn: fakeLlm("A synthesized narrative."),
    });
    expect(r.groupsFound).toBe(1);
    expect(r.conceptsWritten).toBe(1);
    expect(r.tierCounts.T3).toBe(1); // 2 atoms → T3

    const c = await engine.query<{ narrative: string; atom_count: number }>(
      `SELECT narrative, atom_count FROM synth_concepts WHERE concept_slug = 'alpha'`,
    );
    // 2 atoms = T3 → deterministic narrative (LLM only fires for T1/T2).
    expect(c.rows[0]?.narrative).toContain("T3 concept");
    expect(Number(c.rows[0]?.atom_count)).toBe(2);

    const links = await engine.query<{ atom_id: number }>(
      `SELECT atom_id FROM synth_concept_atoms WHERE concept_slug = 'alpha' ORDER BY atom_id`,
    );
    expect(links.rows.map((l) => Number(l.atom_id))).toEqual([a1, a2].sort((x, y) => x - y));
  });

  it("uses the LLM narrative for a T2 group", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["beta"]);
    const r = await synthesizeConceptsPhase(engine, { llmFn: fakeLlm("LLM beta summary.") });
    expect(r.tierCounts.T2).toBe(1);
    const c = await engine.query<{ narrative: string }>(
      `SELECT narrative FROM synth_concepts WHERE concept_slug = 'beta'`,
    );
    expect(c.rows[0]?.narrative).toBe("LLM beta summary.");
  });

  it("is idempotent — re-running upserts, not duplicates", async () => {
    await seedAtom(["gamma"]);
    await seedAtom(["gamma"]);
    const llm = fakeLlm("n");
    await synthesizeConceptsPhase(engine, { llmFn: llm });
    await synthesizeConceptsPhase(engine, { llmFn: llm });
    const c = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_concepts`);
    expect(Number(c.rows[0]?.n)).toBe(1);
  });

  it("fails open — LLM error falls back to deterministic narrative", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["delta"]);
    const boom: LlmFn = async () => {
      throw new Error("nova error");
    };
    const r = await synthesizeConceptsPhase(engine, { llmFn: boom });
    expect(r.conceptsWritten).toBe(1);
    expect(r.errors.length).toBe(1);
    const c = await engine.query<{ narrative: string }>(
      `SELECT narrative FROM synth_concepts WHERE concept_slug = 'delta'`,
    );
    expect(c.rows[0]?.narrative).toContain("T2 concept");
  });

  // A call-count cap is not a spend cap — 30 calls cost whatever 30 calls cost,
  // and nothing stopped the phase spending against an unpriced model. These two
  // assert the USD ceiling is real: that it blocks the call, and that a run
  // without it still calls the model (so the guard is not just always-on).
  it("a USD ceiling blocks the paid call and keeps the deterministic narrative", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["beta"]); // 5 atoms → T2 → wants LLM
    let calls = 0;
    const r = await synthesizeConceptsPhase(engine, {
      budget: new BudgetTracker(0.0000001, "test"),
      llmFn: (async () => {
        calls += 1;
        return { text: "paid narrative", modelId: HAIKU, usage: { inputTokens: 1000, outputTokens: 300 } };
      }) as LlmFn,
    });
    expect(calls).toBe(0);
    expect(r.budgetHit).toBe(true);
    expect(r.conceptsWritten).toBe(1);
  });

  it("without a ceiling the same run does call the model", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["gamma"]);
    let calls = 0;
    await synthesizeConceptsPhase(engine, {
      llmFn: (async () => {
        calls += 1;
        return { text: "paid narrative", modelId: HAIKU, usage: { inputTokens: 1000, outputTokens: 300 } };
      }) as LlmFn,
    });
    expect(calls).toBeGreaterThan(0);
  });

  // The pairing is the whole mechanism: the pre-call check can only fire if the
  // post-call record actually accumulated. This proves it — group 1 pays, group
  // 2 is refused, with the SAME budget object.
  it("spend accumulates across groups, so a later call is refused", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["delta"]);
    for (let i = 0; i < 5; i++) await seedAtom(["epsilon"]);
    let calls = 0;
    const r = await synthesizeConceptsPhase(engine, {
      budget: new BudgetTracker(0.0031, "test"),
      llmFn: (async () => {
        calls += 1;
        return { text: "paid narrative", modelId: HAIKU, usage: { inputTokens: 1000, outputTokens: 400 } };
      }) as LlmFn,
    });
    expect(calls).toBe(1);
    expect(r.budgetHit).toBe(true);
    expect(r.conceptsWritten).toBe(2);
  });

  // An unpriced model adds nothing to `spent`, so without a stop flag the phase
  // would repeat the same unpriced paid call up to maxConcepts.
  it("an unpriced model stops paid calls instead of repeating them", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["zeta"]);
    for (let i = 0; i < 5; i++) await seedAtom(["eta"]);
    let calls = 0;
    const r = await synthesizeConceptsPhase(engine, {
      llmFn: (async () => {
        calls += 1;
        return { text: "paid", modelId: "some-unpriced-model", usage: { inputTokens: 10, outputTokens: 10 } };
      }) as LlmFn,
    });
    expect(calls).toBe(1);
    expect(r.budgetHit).toBe(true);
  });
});

