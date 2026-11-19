/**
 * LongMemEval retrieval-only (`lme-r`): the same per-question brains and the
 * same hybrid search as the judged run, scored by whether the evidence
 * sessions come back — no answer model, no judge. Embeddings still go through
 * the spend ledger, and a vector cache keyed by model and text makes a repeat
 * run free.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LmeQuestion } from "../src/eval/longmemeval/dataset.ts";
import {
  estimateLongMemEval,
  LME_RETRIEVAL_LABEL,
  runLongMemEval,
  scoreSessionRecall,
  type LmeBedrock,
} from "../src/eval/longmemeval/harness.ts";
import { runEvalLongMemEval } from "../src/commands/eval-longmemeval.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60000);

const DATASET = { url: "https://example.invalid/lme.json", sha256: "b".repeat(64) };

function q(id: string, type: string, question: string, sessions: string[][], answerIdx: number[]): LmeQuestion {
  return {
    question_id: id, question_type: type, question, answer: "x", question_date: "2023/05/20 (Sat) 10:00",
    sessions: sessions.map((turns, i) => ({
      id: `${id}_s${i}`, date: `2023/05/${10 + i} (Wed) 09:00`,
      turns: turns.map((content, t) => ({ role: t % 2 === 0 ? "user" : "assistant", content })),
    })),
    answer_session_ids: answerIdx.map((i) => `${id}_s${i}`),
  };
}

const QUESTIONS: LmeQuestion[] = [
  q("q1", "single-session-user", "Which garage level did I park the car on?", [
    ["I parked the car on garage level 3 this morning.", "Noted, level 3 of the garage."],
    ["Can you suggest a pasta recipe with basil?", "Try a simple pesto pasta."],
  ], [0]),
  q("q2_abs", "single-session-user", "Which garage level did I park the car on?", [
    ["My tomatoes need more sun in the garden.", "Move them to the south bed."],
  ], []),
  q("q3", "multi-session", "What breed is my dog and where did we adopt him?", [
    ["We adopted a dog last week, a beagle named Max.", "Congratulations on adopting Max!"],
    ["The shelter on Elm road had many dogs.", "Shelters are great places to adopt."],
    ["My sister bought a new bicycle.", "Nice, what kind?"],
  ], [0, 1]),
];

interface Calls { embeds: number; converse: number }

function stub(calls: Calls): LmeBedrock {
  return {
    embed: async (text) => {
      calls.embeds++;
      return { vector: deterministicEmbed(text), inputTokens: Math.ceil(Buffer.byteLength(text) / 4) };
    },
    converse: async () => {
      calls.converse++;
      throw new Error("retrieval-only must never call a chat model");
    },
  };
}

describe("scoreSessionRecall", () => {
  it("scores recall over the distinct sessions of the top chunk rows", () => {
    const r = scoreSessionRecall(["a", "a", "b", "c", "d", "e", "f"], ["b", "z"]);
    expect(r.recall_any_at_5).toBe(1);
    expect(r.recall_all_at_5).toBe(0);
    expect(r.ndcg_at_10).toBeGreaterThan(0);
    expect(scoreSessionRecall(["x", "y", "z", "w", "v", "b"], ["b"]).recall_any_at_5).toBe(0);
    expect(scoreSessionRecall(["x", "y", "z", "w", "v", "b"], ["b"]).recall_any_at_10).toBe(1);
  });
});

describe("runLongMemEval --retrieval-only", () => {
  let out: string;
  let cache: string;
  let calls: Calls;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "memrain-lmer-"));
    cache = mkdtempSync(join(tmpdir(), "memrain-lmer-cache-"));
    calls = { embeds: 0, converse: 0 };
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("scores session recall with no answer or judge call and nothing reserved for them", async () => {
    const r = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true });
    expect(r.outcome).toBe("complete");
    expect(calls.converse).toBe(0);
    const s = r.summary;
    expect(s.label).toBe(LME_RETRIEVAL_LABEL);
    expect(s.recall_any_at_5).toBe(1);
    expect(s.recall_scored).toBe(2);
    const lines = readFileSync(join(out, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: string; stage?: string });
    expect(lines.filter((l) => l.t === "reserve" && (l.stage === "answer" || l.stage === "judge"))).toEqual([]);
    expect(lines.filter((l) => l.t === "reserve").length).toBe(calls.embeds);
  });

  it("records the ranking flags it ran under and which questions it covered", async () => {
    // eval promote pairs two summaries by these: a baseline passed twice, or
    // runs over different questions, must not count as measuring a flag.
    const prev = process.env.MEMRAIN_RANK_EXACT_LOOKUP;
    process.env.MEMRAIN_RANK_EXACT_LOOKUP = "1";
    try {
      const r = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true });
      expect(r.summary.ranking_flags).toEqual(["EXACT_LOOKUP"]);
      const other = await runLongMemEval({ questions: QUESTIONS.slice(0, 1), dataset: DATASET, outDir: join(out, "one"), maxUsd: 1, bedrock: stub(calls), retrievalOnly: true });
      expect(typeof r.summary.question_ids_sha256).toBe("string");
      expect(other.summary.question_ids_sha256).not.toBe(r.summary.question_ids_sha256);
      // Resuming the directory with different flags would mix two configurations.
      delete process.env.MEMRAIN_RANK_EXACT_LOOKUP;
      await expect(runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true })).rejects.toThrow(/different/);
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_RANK_EXACT_LOOKUP;
      else process.env.MEMRAIN_RANK_EXACT_LOOKUP = prev;
    }
  });

  it("prices only the embeddings in a dry run", () => {
    const e = estimateLongMemEval({ questions: QUESTIONS, retrievalOnly: true });
    expect(e.stages.answer.max_usd).toBe(0);
    expect(e.stages.judge.max_usd).toBe(0);
    expect(e.max_usd).toBe(e.stages.embed.max_usd + e.stages.query_embed.max_usd);
  });

  it("reuses cached vectors: a repeat run embeds nothing and spends nothing", async () => {
    await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true, embedCacheDir: cache });
    const first = calls.embeds;
    expect(first).toBeGreaterThan(0);
    const out2 = mkdtempSync(join(tmpdir(), "memrain-lmer-2-"));
    try {
      const r = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out2, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true, embedCacheDir: cache });
      expect(calls.embeds).toBe(first);
      expect(r.summary.spent_usd).toBe(0);
      expect(r.summary.recall_any_at_5).toBe(1);
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  });

  it("refuses to resume a judged run directory in retrieval-only mode", async () => {
    await runLongMemEval({ questions: QUESTIONS.slice(0, 1), dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls), retrievalOnly: true });
    await expect(runLongMemEval({ questions: QUESTIONS.slice(0, 1), dataset: DATASET, outDir: out, maxUsd: 1, bedrock: stub(calls) })).rejects.toThrow(/different/);
  });
});

describe("eval longmemeval --retrieval-only (command)", () => {
  it("refuses answer and judge models, which a retrieval-only run never uses", async () => {
    const code = await runEvalLongMemEval({ retrievalOnly: true, dryRun: true, answerModel: "x", loadQuestions: async () => ({ questions: QUESTIONS, dataset: DATASET }) });
    expect(code).toBe(2);
  });
});
