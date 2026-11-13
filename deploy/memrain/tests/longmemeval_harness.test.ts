/**
 * LongMemEval harness, end to end and offline: each question is ingested into
 * its own PGLite brain through the real indexer, retrieved through the real
 * hybridSearch, and answered and judged through a stub standing in for
 * Bedrock at the invocation boundary. The spend ledger is the subject as much
 * as the score: every paid call is reserved before it is sent, a cap that
 * cannot cover a call stops the run before the call, and a resumed run never
 * repeats a call it may already have paid for.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LmeQuestion } from "../src/eval/longmemeval/dataset.ts";
import {
  ANSWER_SYSTEM,
  estimateLongMemEval,
  parseJudgeVerdict,
  runLongMemEval,
  settleReservation,
  UnknownPrice,
  type LmeBedrock,
} from "../src/eval/longmemeval/harness.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60000);

const DATASET = { url: "https://example.invalid/lme.json", sha256: "a".repeat(64) };

function q(id: string, type: string, question: string, answer: string, sessions: string[][], answerIdx: number[]): LmeQuestion {
  return {
    question_id: id, question_type: type, question, answer, question_date: "2023/05/20 (Sat) 10:00",
    sessions: sessions.map((turns, i) => ({
      id: `${id}_s${i}`, date: `2023/05/${10 + i} (Wed) 09:00`,
      turns: turns.map((content, t) => ({ role: t % 2 === 0 ? "user" : "assistant", content })),
    })),
    answer_session_ids: answerIdx.map((i) => `${id}_s${i}`),
  };
}

const QUESTIONS: LmeQuestion[] = [
  q("q1", "single-session-user", "Which garage level did I park the car on?", "level 3", [
    ["I parked the car on garage level 3 this morning.", "Noted, level 3 of the garage."],
    ["Can you suggest a pasta recipe with basil?", "Try a simple pesto pasta."],
  ], [0]),
  q("q2_abs", "single-session-user", "Which garage level did I park the car on?", "You did not mention a garage", [
    ["My tomatoes need more sun in the garden.", "Move them to the south bed."],
  ], []),
  q("q3", "knowledge-update", "What breed is my dog?", "beagle", [
    ["We adopted a dog last week, a beagle named Max.", "Congratulations on adopting Max!"],
  ], [0]),
];

interface Calls { embeds: string[]; converse: { system: string; user: string; maxTokens: number; modelId: string }[] }

function stubBedrock(calls: Calls, opts: { failJudgeFor?: string } = {}): LmeBedrock {
  return {
    embed: async (text) => {
      calls.embeds.push(text);
      return { vector: deterministicEmbed(text), inputTokens: Math.ceil(Buffer.byteLength(text) / 4) };
    },
    converse: async (input) => {
      calls.converse.push(input);
      const inputTokens = Math.ceil(Buffer.byteLength(input.system + input.user) / 4);
      if (input.system === ANSWER_SYSTEM) {
        const m = /level \d|beagle/.exec(input.user.split("Question:")[0]!);
        return { text: m ? `It was ${m[0]}.` : "I don't know.", inputTokens, outputTokens: 6 };
      }
      if (opts.failJudgeFor && input.user.includes(opts.failJudgeFor)) throw new Error("bedrock: connection reset");
      const correct = /Correct answer: (.*)/.exec(input.user)![1]!.toLowerCase();
      const response = /Response: (.*)/.exec(input.user)![1]!.toLowerCase();
      const ok = response.includes(correct) || (correct.startsWith("you did not") && response.includes("don't know"));
      return { text: ok ? "yes" : "no", inputTokens, outputTokens: 1 };
    },
  };
}

function ledgerLines(out: string): Record<string, unknown>[] {
  return readFileSync(join(out, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("runLongMemEval", () => {
  let out: string;
  let calls: Calls;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "memrain-lme-run-"));
    calls = { embeds: [], converse: [] };
  });
  afterEach(() => { rmSync(out, { recursive: true, force: true }); });

  it("scores every question through ingestion, real retrieval, answer and judge", async () => {
    const r = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls) });
    expect(r.outcome).toBe("complete");
    const s = r.summary;
    expect(s.label).toBe("Bedrock-Claude-judged");
    expect(s.dataset.sha256).toBe(DATASET.sha256);
    expect(s.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.models.answer).not.toBe(s.models.judge);
    expect(s.scored).toBe(3);
    expect(s.correct).toBe(3);
    expect(s.accuracy).toBe(1);
    const results = Object.fromEntries(ledgerLines(out).filter((l) => l.t === "result").map((l) => [l.question_id, l]));
    expect(results.q1!.retrieved_session_ids).toContain("q1_s0");
    expect(results.q1!.evidence_recall).toBe(1);
  });

  it("keeps each question's history in its own brain and its labels away from the models", async () => {
    await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls) });
    const answerPrompts = calls.converse.filter((c) => c.system === ANSWER_SYSTEM);
    const q2Prompt = answerPrompts.find((c) => c.user.includes("tomatoes"))!;
    expect(q2Prompt.user).not.toContain("level 3");
    for (const c of answerPrompts) expect(c.user).not.toMatch(/has_answer|_s\d|answer_session/);
    for (const text of calls.embeds) expect(text).not.toContain("has_answer");
  });

  it("reserves every paid call before it is sent, with an explicit output cap, and settles it", async () => {
    await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls) });
    for (const c of calls.converse) expect(c.maxTokens).toBeGreaterThan(0);
    const lines = ledgerLines(out);
    const reserves = lines.filter((l) => l.t === "reserve");
    expect(reserves.length).toBe(calls.embeds.length + calls.converse.length);
    const settled = new Set(lines.filter((l) => l.t === "settle").map((l) => l.id));
    for (const r of reserves) expect(settled.has(r.id)).toBe(true);
    expect(reserves.filter((l) => l.stage === "answer").every((l) => (l.max_tokens as number) > 0)).toBe(true);
  });

  it("refuses before the first call when the cap cannot cover it", async () => {
    const r = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 0.000001, bedrock: stubBedrock(calls) });
    expect(r.outcome).toBe("cap_exceeded");
    expect(calls.embeds.length + calls.converse.length).toBe(0);
    expect(ledgerLines(out).filter((l) => l.t === "reserve")).toEqual([]);
  });

  it("sends no further paid call once one has failed", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i} about the allotment: ${"we planted beans and squash along the fence ".repeat(30)}`);
    const long = q("q_long", "single-session-user", "What did we plant?", "beans", [[paragraphs.join("\n\n"), "ok"]], [0]);
    let sent = 0;
    const failing: LmeBedrock = {
      embed: async (text) => {
        sent++;
        if (sent === 1) throw new Error("bedrock: throttled");
        await new Promise((r) => setTimeout(r, 20));
        return { vector: deterministicEmbed(text), inputTokens: 5 };
      },
      converse: async () => { throw new Error("unreachable"); },
    };
    const r = await runLongMemEval({ questions: [long], dataset: DATASET, outDir: out, maxUsd: 5, bedrock: failing });
    expect(r.outcome).toBe("call_failed");
    const atReturn = sent;
    await new Promise((res) => setTimeout(res, 500));
    expect(sent).toBe(atReturn);
    const lines = ledgerLines(out);
    const settledIds = new Set(lines.filter((l) => l.t === "settle").map((l) => l.id));
    expect(lines.filter((l) => l.t === "reserve").every((l) => settledIds.has(l.id))).toBe(true);
  });

  it("does not let a search retry a query embedding that already failed", async () => {
    const lonely = q("q_lonely", "single-session-user", "zebra xylophone quokka?", "none", [["Nothing in common here.", "ok"]], []);
    const queryCalls: string[] = [];
    const failingQuery: LmeBedrock = {
      embed: async (text) => {
        if (text.includes("zebra")) {
          queryCalls.push(text);
          throw new Error("bedrock: throttled");
        }
        return { vector: deterministicEmbed(text), inputTokens: 5 };
      },
      converse: async () => { throw new Error("unreachable"); },
    };
    const r = await runLongMemEval({ questions: [lonely], dataset: DATASET, outDir: out, maxUsd: 5, bedrock: failingQuery });
    expect(r.outcome).toBe("call_failed");
    expect(queryCalls).toHaveLength(1);
  });

  it("refuses an input over its bound instead of pricing it", async () => {
    const huge = { ...QUESTIONS[2]!, question_id: "q_huge", question: `${"what breed is my dog ".repeat(3000)}?` };
    const r = await runLongMemEval({ questions: [huge], dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls) });
    expect(r.outcome).toBe("refused");
    expect(r.message).toContain("bound");
    expect(calls.embeds.some((t) => t.startsWith("what breed"))).toBe(false);
    expect(calls.converse).toEqual([]);
  });

  it("refuses an unpriced model before any call", async () => {
    await expect(runLongMemEval({
      questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5,
      models: { answer: "mystery-model" }, bedrock: stubBedrock(calls),
    })).rejects.toBeInstanceOf(UnknownPrice);
    expect(calls.embeds.length + calls.converse.length).toBe(0);
  });

  it("never repeats a call a crashed run may have paid for, and charges it in full", async () => {
    const first = await runLongMemEval({
      questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls, { failJudgeFor: "park" }),
    });
    expect(first.outcome).toBe("call_failed");
    // The process dying between the call and its settlement leaves the
    // reservation open: drop the settle the failure path wrote.
    const lines = readFileSync(join(out, "ledger.jsonl"), "utf8").trim().split("\n");
    const failed = JSON.parse(lines.at(-1)!);
    expect(failed.t).toBe("settle");
    writeFileSync(join(out, "ledger.jsonl"), `${lines.slice(0, -1).join("\n")}\n`);
    const open = lines.map((l) => JSON.parse(l)).find((l) => l.id === failed.id && l.t === "reserve");

    const again: Calls = { embeds: [], converse: [] };
    const second = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(again) });
    expect(second.outcome).toBe("complete");
    expect(again.converse.some((c) => c.user.includes("level 3"))).toBe(false);
    expect(again.embeds.some((t) => t.includes("level 3"))).toBe(false);
    const s = second.summary;
    expect(s.interrupted).toEqual(["q1"]);
    expect(s.scored).toBe(2);
    expect(s.unsettled_reservations.map((u) => u.id)).toEqual([open.id]);
    expect(s.spent_usd).toBeGreaterThanOrEqual(open.max_usd);

    const before = s.spent_usd;
    settleReservation(out, open.id, 0);
    const third = await runLongMemEval({ questions: QUESTIONS, dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock({ embeds: [], converse: [] }) });
    expect(third.summary.unsettled_reservations).toEqual([]);
    expect(third.summary.spent_usd).toBeCloseTo(before - open.max_usd, 10);
  });

  it("refuses to resume a ledger written under different prompts, models or data", async () => {
    await runLongMemEval({ questions: QUESTIONS.slice(0, 1), dataset: DATASET, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls) });
    await expect(runLongMemEval({
      questions: QUESTIONS, dataset: { ...DATASET, sha256: "b".repeat(64) }, outDir: out, maxUsd: 5, bedrock: stubBedrock(calls),
    })).rejects.toThrow(/different/);
  });
});

describe("estimateLongMemEval (dry run)", () => {
  it("prices the worst case of every stage without a single call or ledger write", () => {
    const out = mkdtempSync(join(tmpdir(), "memrain-lme-dry-"));
    try {
      const e = estimateLongMemEval({ questions: QUESTIONS, maxUsd: 5 });
      expect(e.questions).toBe(3);
      expect(e.max_usd).toBeGreaterThan(0);
      expect(e.stages.answer.max_tokens).toBeGreaterThan(0);
      expect(e.stages.judge.max_tokens).toBeGreaterThan(0);
      expect(e.cap_covers).toBe(true);
      expect(estimateLongMemEval({ questions: QUESTIONS, maxUsd: 0.000001 }).cap_covers).toBe(false);
      expect(existsSync(join(out, "ledger.jsonl"))).toBe(false);
      expect(() => estimateLongMemEval({ questions: QUESTIONS, models: { judge: "mystery-model" } })).toThrow(UnknownPrice);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("parseJudgeVerdict", () => {
  it("reads a leading yes or no and nothing else", () => {
    expect(parseJudgeVerdict("yes")).toBe(true);
    expect(parseJudgeVerdict(" Yes.")).toBe(true);
    expect(parseJudgeVerdict("NO")).toBe(false);
    expect(parseJudgeVerdict("no, the response is wrong")).toBe(false);
    expect(parseJudgeVerdict("The answer is yes")).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
    expect(parseJudgeVerdict("yesterday")).toBeNull();
  });
});
