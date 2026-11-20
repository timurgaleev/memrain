/**
 * Auto-think end-to-end: a SYNTHESIS phase driven through the real cycle
 * dispatcher (runCycleOnce), not the phase in isolation. Proves that when the
 * operator flips MEMRAIN_DREAM_SYNTHESIS on, the synthesis chain actually runs via
 * the cycle and writes to the isolated synth_* store — and that the configured
 * llmFn flows through `options.synthesis`. Hermetic: mocked LLM, no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { runCycleOnce } from "../src/core/cycle/index.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-autothink-e2e-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
async function seedAtom(concept: string): Promise<void> {
  n += 1;
  await engine.query("INSERT INTO documents (id, source_path, source_id) VALUES ('d1', '/vault/d1.md', 'default') ON CONFLICT DO NOTHING");
  await engine.query(
    `INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id)
     VALUES ($1, 'd1', 'h1', $2, 'body', $3::jsonb, 'm')`,
    [`k-${n}`, `atom-${n}`, JSON.stringify([concept])],
  );
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("auto-think e2e — synthesis through runCycleOnce", () => {
  it("the cycle runs synthesize-concepts and writes a concept (LLM narrative flows through)", async () => {
    // 5 atoms on one concept → a T2 group, whose narrative comes from the LLM.
    for (let i = 0; i < 5; i++) await seedAtom("gamma");

    const r = await runCycleOnce(engine, {
      phases: ["synthesize-concepts"],
      staleDays: 99999,
      synthesis: { llmFn: fakeLlm("CYCLE-DRIVEN narrative") },
    });

    // The phase ran via the dispatcher and didn't error.
    expect(r.phases.some((p) => p.phase === "synthesize-concepts")).toBe(true);

    // The concept actually landed in the isolated synth_* store...
    const c = await engine.query<{ narrative: string; atom_count: number }>(
      `SELECT narrative, atom_count FROM synth_concepts WHERE concept_slug = 'gamma'`,
    );
    expect(c.rows.length).toBe(1);
    expect(Number(c.rows[0]?.atom_count)).toBe(5);
    // ...and the llmFn we passed via options.synthesis reached the phase.
    expect(c.rows[0]?.narrative).toBe("CYCLE-DRIVEN narrative");
  });

  it("a cycle WITHOUT the synthesis phase writes no concepts", async () => {
    for (let i = 0; i < 5; i++) await seedAtom("delta");
    await runCycleOnce(engine, { phases: ["snapshot"], staleDays: 99999 });
    const c = await engine.query(`SELECT 1 FROM synth_concepts`);
    expect(c.rows.length).toBe(0);
  });
});
