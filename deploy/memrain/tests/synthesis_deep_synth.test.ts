/**
 * deep-synth cadence tests — hermetic, MOCKED SonnetFn (no Bedrock). Covers the
 * default-OFF gate, empty-standing-questions skip, budget pre-flight skip,
 * standing-question derivation from synth_concepts, the happy path (returns
 * syntheses, records spend), and fail-open on model errors.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { runDeepSynthPhase } from "../src/core/synthesis/deep-synth.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";
import { BudgetTracker } from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-deep-synth-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedConcept(slug: string, title: string, atomCount: number): Promise<void> {
  await engine.query(
    `INSERT INTO synth_concepts
       (concept_slug, title, tier, atom_count, narrative, model_id)
     VALUES ($1, $2, 'theme', $3, 'n', 'fake-nova')`,
    [slug, title, atomCount],
  );
}

const okResponse = JSON.stringify({
  answer: "The corpus favors migration [notes/plan.md].",
  citations: [{ ref: "notes/plan.md", kind: "page" }],
  gaps: [],
});

const fakeSonnet = (text: string, usage = { inputTokens: 100, outputTokens: 50 }): SonnetFn =>
  async () => ({ text, modelId: "eu.anthropic.claude-sonnet-4-6", usage });

// hybridSearch has no offline embedder — inject a deterministic page retriever.
const fakePages =
  (hits: Partial<SearchHit>[] = []) =>
  async (): Promise<SearchHit[]> =>
    hits as SearchHit[];

describe("runDeepSynthPhase", () => {
  it("is default-OFF without MEMRAIN_DEEP_SYNTH and no injected sonnetFn", async () => {
    const prev = process.env.MEMRAIN_DEEP_SYNTH;
    delete process.env.MEMRAIN_DEEP_SYNTH;
    try {
      const r = await runDeepSynthPhase(storage, { questions: ["what is the plan?"] });
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_DEEP_SYNTH");
      expect(r.syntheses).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_DEEP_SYNTH = prev;
    }
  });

  it("runs (ran=true) with 0 questions when none supplied and synth_concepts is empty", async () => {
    const r = await runDeepSynthPhase(storage, {
      sonnetFn: fakeSonnet(okResponse),
      pagesFn: fakePages(),
    });
    expect(r.ran).toBe(true);
    expect(r.questionsAsked).toBe(0);
    expect(r.syntheses).toEqual([]);
    expect(r.reason).toContain("no standing questions");
  });

  it("injected sonnetFn bypasses the gate and returns syntheses (happy path)", async () => {
    const r = await runDeepSynthPhase(storage, {
      questions: ["what is the plan?"],
      sonnetFn: fakeSonnet(okResponse),
      pagesFn: fakePages([{ sourcePath: "notes/plan.md", content: "the plan is to migrate" }]),
    });
    expect(r.ran).toBe(true);
    expect(r.questionsAsked).toBe(1);
    expect(r.syntheses).toHaveLength(1);
    expect(r.syntheses[0]!.question).toBe("what is the plan?");
    expect(r.syntheses[0]!.synthesis.answer).toContain("migration");
    expect(r.syntheses[0]!.pagesGathered).toBe(1);
    expect(r.spentUsd).toBeGreaterThan(0);
    expect(r.budgetExhausted).toBe(false);
  });

  it("derives standing questions from top synth_concepts titles when none supplied", async () => {
    await seedConcept("c-low", "Low salience concept", 2);
    await seedConcept("c-high", "High salience concept", 50);
    const seen: string[] = [];
    const spy: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: okResponse, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const r = await runDeepSynthPhase(storage, {
      sonnetFn: spy,
      pagesFn: fakePages(),
      maxQuestions: 1,
    });
    // atom_count DESC — the high-salience concept becomes the standing question.
    expect(r.questionsAsked).toBe(1);
    expect(r.syntheses).toHaveLength(1);
    expect(r.syntheses[0]!.question).toBe("High salience concept");
    expect(seen[0]).toContain("High salience concept");
  });

  it("skips before spending when the budget can't fit one question (pre-flight)", async () => {
    let called = false;
    const spy: SonnetFn = async () => {
      called = true;
      return { text: okResponse, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await runDeepSynthPhase(storage, {
      questions: ["q1", "q2"],
      sonnetFn: spy,
      pagesFn: fakePages(),
      maxBudgetUsd: 0.0000001,
    });
    expect(called).toBe(false);
    expect(r.questionsAsked).toBe(0);
    expect(r.budgetExhausted).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.syntheses).toEqual([]);
  });

  it("stops after a question tips the shared budget ceiling (partial progress kept)", async () => {
    // The conservative pre-flight prices one question at ~$0.0375 (fixed 20K-char
    // evidence allowance). A cap just above one estimate lets the FIRST question
    // run and records its actual (tiny) spend; the SECOND pre-flight then adds the
    // recorded spend to the next estimate, exceeds the cap, and stops the loop.
    const budget = new BudgetTracker(0.0376, "deep-synth-test");
    const r = await runDeepSynthPhase(storage, {
      questions: ["q1", "q2", "q3"],
      sonnetFn: fakeSonnet(okResponse),
      pagesFn: fakePages(),
      budget,
      modelId: "eu.anthropic.claude-sonnet-4-6",
    });
    expect(r.syntheses).toHaveLength(1);
    expect(r.budgetExhausted).toBe(true);
    expect(r.spentUsd).toBeGreaterThan(0);
  });

  it("fails open: a model error skips that question rather than throwing", async () => {
    const boom: SonnetFn = async () => {
      throw new Error("bedrock exploded");
    };
    const r = await runDeepSynthPhase(storage, {
      questions: ["q1"],
      sonnetFn: boom,
      pagesFn: fakePages(),
    });
    expect(r.ran).toBe(true);
    expect(r.questionsAsked).toBe(1);
    expect(r.syntheses).toEqual([]);
  });

  it("tolerates unparseable model output (no synthesis, spend still recorded)", async () => {
    const r = await runDeepSynthPhase(storage, {
      questions: ["q1"],
      sonnetFn: fakeSonnet("sorry, I cannot help"),
      pagesFn: fakePages(),
    });
    expect(r.ran).toBe(true);
    expect(r.syntheses).toEqual([]);
    expect(r.spentUsd).toBeGreaterThan(0);
  });

  it("stops before the next question once its signal aborts", async () => {
    const c = new AbortController();
    let calls = 0;
    const abortingSonnet: SonnetFn = async () => {
      calls++;
      c.abort("lock_stolen");
      return { text: okResponse, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 100, outputTokens: 50 } };
    };
    const r = await runDeepSynthPhase(storage, {
      questions: ["first?", "second?", "third?"],
      sonnetFn: abortingSonnet,
      pagesFn: fakePages(),
      signal: c.signal,
    });
    expect(calls).toBe(1);
    expect(r.questionsAsked).toBe(1);
  });
});
