/**
 * propose_takes + grade_takes phase tests — hermetic, MOCKED llmFn (no
 * Bedrock). Verifies queue-only proposals, idempotency, evidence-grounded
 * grading, parse fallbacks, and fail-open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  proposeTakesPhase,
  gradeTakesPhase,
  gradeTakeEnsemble,
  parseTakesResponse,
  parseVerdictResponse,
  aggregateVerdicts,
} from "../src/core/synthesis/takes.ts";
import { STOP_REASON_MAX_TOKENS } from "../src/core/llm/sonnet.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { BudgetTracker, costUsd } from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-takes-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`, [
    id,
    `/vault/${id}.md`,
    id,
  ]);
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

/** A failed call parks the document (synth_failures); let that wait run out. */
async function expireBackoff(): Promise<void> {
  await engine.query(`UPDATE synth_failures SET next_eligible_at = now() - interval '1 second'`);
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

// Stateful Sonnet stub: returns each text in turn (last one repeats), with a
// tiny fixed token usage so the default $1 budget easily covers a few judges.
const seqSonnet = (texts: string[]): SonnetFn => {
  let i = 0;
  return async () => ({
    text: texts[Math.min(i++, texts.length - 1)]!,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 50 },
  });
};

/**
 * Scripted transports: one reply per call (the last repeats), recording the
 * output cap every call asked for. A `stopReason` is Bedrock saying it cut the
 * answer off at that cap — the signal a structured-output caller has to act on.
 */
function scriptedLlm(replies: { text: string; stopReason?: string }[]) {
  const caps: number[] = [];
  const fn: LlmFn = async (input) => {
    const r = replies[Math.min(caps.length, replies.length - 1)]!;
    caps.push(input.maxTokens);
    return {
      text: r.text,
      modelId: "fake-nova",
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
    };
  };
  return { fn, caps };
}

function scriptedSonnet(replies: { text: string; stopReason?: string }[]) {
  const caps: number[] = [];
  const fn: SonnetFn = async (input) => {
    const r = replies[Math.min(caps.length, replies.length - 1)]!;
    caps.push(input.maxTokens);
    return {
      text: r.text,
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 100, outputTokens: 50 },
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
    };
  };
  return { fn, caps };
}

describe("parseTakesResponse / parseVerdictResponse", () => {
  it("parses takes and clamps weight", () => {
    const t = parseTakesResponse(`[{"claim_text":"X will win","kind":"prediction","weight":5,"domain":"macro"}]`);
    expect(t.length).toBe(1);
    expect(t[0]?.weight).toBe(1);
    expect(t[0]?.domain).toBe("macro");
  });
  it("parses a verdict object", () => {
    const v = parseVerdictResponse(`{"verdict":"correct","confidence":0.9,"reasoning":"ok"}`);
    expect(v?.verdict).toBe("correct");
    expect(v?.confidence).toBe(0.9);
  });
  it("returns null on bad verdict", () => {
    expect(parseVerdictResponse("garbage")).toBeNull();
  });
});

describe("proposeTakesPhase", () => {
  it("queues takes only in synth_takes with status queued", async () => {
    await seedDoc("d1", "Z".repeat(500));
    const r = await proposeTakesPhase(engine, {
      llmFn: fakeLlm(`[{"claim_text":"X will happen","kind":"prediction","weight":0.7}]`),
    });
    expect(r.takesQueued).toBe(1);
    const { rows } = await engine.query<{ status: string; source_ref: string }>(
      `SELECT status, source_ref FROM synth_takes`,
    );
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.source_ref).toBe("d1");
  });

  it("is idempotent across runs", async () => {
    await seedDoc("d1", "Y".repeat(500));
    const llm = fakeLlm(`[{"claim_text":"stable claim","kind":"judgment","weight":0.5}]`);
    await proposeTakesPhase(engine, { llmFn: llm });
    const r2 = await proposeTakesPhase(engine, { llmFn: llm });
    expect(r2.documentsScanned).toBe(0);
    const { rows } = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_takes`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("fails open on LLM error", async () => {
    await seedDoc("d1", "W".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("down");
    };
    const r = await proposeTakesPhase(engine, { llmFn: boom });
    expect(r.takesQueued).toBe(0);
    expect(r.errors.length).toBe(1);
  });
});

describe("gradeTakesPhase", () => {
  // Seed a take dated a year back so it clears the default 6-month grade age
  // gate (grading targets claims old enough to have resolved).
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
      [`tk-${id}`, claim],
    );
  }

  it("grades a queued take with injected evidence", async () => {
    await seedTake(1, "the claim");
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "strong supporting evidence",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.88,"reasoning":"matches"}`),
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ verdict: string; confidence: number }>(
      `SELECT verdict, confidence FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("correct");
    expect(Number(rows[0]?.confidence)).toBeCloseTo(0.88, 5);
  });

  it("records a parse failure as unresolvable rather than dropping the take", async () => {
    await seedTake(1, "claim");
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "e",
      llmFn: fakeLlm("not json"),
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ verdict: string; reasoning: string }>(
      `SELECT verdict, reasoning FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("unresolvable");
    expect(rows[0]?.reasoning).toBe("judge_output_parse_failed");
  });

  it("is idempotent — an already-graded take is not re-scanned, no duplicate grade", async () => {
    await seedTake(1, "claim");
    const opts = {
      evidenceFn: async () => "same evidence",
      llmFn: fakeLlm(`{"verdict":"partial","confidence":0.5,"reasoning":"mixed"}`),
    };
    const r1 = await gradeTakesPhase(engine, opts);
    const r2 = await gradeTakesPhase(engine, opts);
    expect(r1.gradesWritten).toBe(1);
    // Discovery's NOT EXISTS filter drops the already-graded take → not re-scanned.
    expect(r2.takesScanned).toBe(0);
    expect(r2.gradesWritten).toBe(0);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("the grade row carries provenance: take_id + model_id", async () => {
    await seedTake(1, "the claim");
    await gradeTakesPhase(engine, {
      evidenceFn: async () => "evidence",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.9,"reasoning":"r"}`),
    });
    const { rows } = await engine.query<{ take_id: number; model_id: string }>(
      `SELECT g.take_id, g.model_id FROM synth_take_grades g`,
    );
    expect(Number(rows[0]?.take_id)).toBeGreaterThan(0);
    expect(rows[0]?.model_id).toBe("fake-nova");
  });
});

describe("gradeTakesPhase — judge prompt carries real content (regression: [object Object])", () => {
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
      [`tk-${id}`, claim],
    );
  }

  it("single-pass judge sees the claim + evidence text, never [object Object]", async () => {
    await seedTake(1, "aluminium prices will fall in Q3");
    let seen = "";
    const capturingLlm: LlmFn = async (req) => {
      seen = req.user;
      return { text: `{"verdict":"correct","confidence":0.9,"reasoning":"r"}`, modelId: "fake-nova" };
    };
    await gradeTakesPhase(engine, {
      evidenceFn: async () => "the futures curve inverted",
      llmFn: capturingLlm,
    });
    expect(seen).not.toContain("[object Object]");
    expect(seen).toContain("aluminium prices will fall in Q3");
    expect(seen).toContain("the futures curve inverted");
  });

  it("ensemble judge sees the claim + evidence text, never [object Object]", async () => {
    await seedTake(1, "copper demand will spike");
    let seen = "";
    const capturingSonnet: SonnetFn = async (req) => {
      seen = req.user;
      return {
        text: `{"verdict":"correct","confidence":0.8,"reasoning":"a"}`,
        modelId: "eu.anthropic.claude-sonnet-4-6",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };
    await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "smelter outages reported",
      sonnetFn: capturingSonnet,
      judges: 1,
    });
    expect(seen).not.toContain("[object Object]");
    expect(seen).toContain("copper demand will spike");
    expect(seen).toContain("smelter outages reported");
  });
});

describe("aggregateVerdicts", () => {
  it("returns null on no votes", () => {
    expect(aggregateVerdicts([])).toBeNull();
  });
  it("picks the majority verdict and the median confidence of the winners", () => {
    const a = aggregateVerdicts([
      { verdict: "correct", confidence: 0.8, reasoning: "a" },
      { verdict: "correct", confidence: 0.6, reasoning: "b" },
      { verdict: "partial", confidence: 0.9, reasoning: "c" },
    ]);
    expect(a?.verdict).toBe("correct");
    expect(a?.confidence).toBeCloseTo(0.7, 5); // median of [0.6, 0.8]
    expect(a?.reasoning).toBe("a");
  });
  it("breaks a tie toward the higher summed confidence", () => {
    const a = aggregateVerdicts([
      { verdict: "correct", confidence: 0.5, reasoning: "a" },
      { verdict: "incorrect", confidence: 0.95, reasoning: "b" },
    ]);
    expect(a?.verdict).toBe("incorrect");
  });
});

describe("gradeTakesPhase — Sonnet ensemble (S1)", () => {
  // Seed a take dated a year back so it clears the default 6-month grade age
  // gate (grading targets claims old enough to have resolved).
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
      [`tk-${id}`, claim],
    );
  }

  it("grades via a majority vote and records ensemble provenance", async () => {
    await seedTake(1, "the claim");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet([
        `{"verdict":"correct","confidence":0.8,"reasoning":"a"}`,
        `{"verdict":"correct","confidence":0.6,"reasoning":"b"}`,
        `{"verdict":"incorrect","confidence":0.9,"reasoning":"c"}`,
      ]),
      judges: 3,
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{
      verdict: string;
      confidence: number;
      grader_model: string;
      judge_count: number;
      model_id: string;
      prompt_version: string;
    }>(
      `SELECT verdict, confidence, grader_model, judge_count, model_id, prompt_version FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("correct"); // 2 correct vs 1 incorrect
    expect(Number(rows[0]?.confidence)).toBeCloseTo(0.7, 5); // median of [0.6, 0.8]
    expect(rows[0]?.grader_model).toBe("ensemble:3");
    expect(Number(rows[0]?.judge_count)).toBe(3);
    expect(rows[0]?.model_id).toContain("sonnet");
    expect(rows[0]?.prompt_version).toBe("v1-sonnet-ensemble");
  });

  it("judges spent but all unparseable → writes unresolvable, does NOT halt the phase", async () => {
    await seedTake(1, "claim one");
    await seedTake(2, "claim two");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet(["not json at all"]),
      judges: 2,
    });
    // Both takes are graded (phase not halted); each gets an unresolvable row.
    expect(r.takesScanned).toBe(2);
    expect(r.gradesWritten).toBe(2);
    const { rows } = await engine.query<{ verdict: string; grader_model: string; judge_count: number }>(
      `SELECT verdict, grader_model, judge_count FROM synth_take_grades ORDER BY take_id`,
    );
    expect(rows[0]?.verdict).toBe("unresolvable");
    expect(rows[0]?.grader_model).toBe("ensemble:0");
    expect(Number(rows[0]?.judge_count)).toBe(0);
  });

  it("stops (partial progress) when the budget leaves no room for a judge", async () => {
    await seedTake(1, "claim");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "e",
      sonnetFn: seqSonnet([`{"verdict":"correct","confidence":0.9,"reasoning":"r"}`]),
      budget: new BudgetTracker(0.000001, "test"),
      judges: 3,
    });
    expect(r.gradesWritten).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("a truncated judge with no readable verdict is NOT memoized as unresolvable", async () => {
    await seedTake(1, "claim");
    const { fn, caps } = scriptedSonnet([
      { text: `{"verdict":"corr`, stopReason: STOP_REASON_MAX_TOKENS },
    ]);
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: fn,
      judges: 1,
    });
    expect(caps).toEqual([500, 1000]); // the judge bought more room once
    // Contrast with "judges spent but all unparseable" above: THAT writes an
    // unresolvable row. A judge the cap cut off never gave a verdict at all, and
    // the row would key (take_id, prompt_version, evidence_sig) forever.
    expect(r.gradesWritten).toBe(0);
    expect(r.errors.some((e) => e.includes("truncated"))).toBe(true);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("ensemble and single-pass grades coexist under distinct prompt versions", async () => {
    await seedTake(1, "coexist claim");
    await gradeTakesPhase(engine, {
      evidenceFn: async () => "evidence",
      llmFn: fakeLlm(`{"verdict":"partial","confidence":0.5,"reasoning":"nova"}`),
    });
    await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet([`{"verdict":"correct","confidence":0.9,"reasoning":"s"}`]),
      judges: 1,
    });
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(2); // two rows, different prompt_version
  });
});

/**
 * Output-cap truncation on the take phases.
 *
 * Bedrock reports `stopReason: "max_tokens"` when the answer ran out of room.
 * These calls run at temperature 0, so a same-cap retry — this run or the next
 * — truncates in the identical place: the only useful retry buys MORE room, and
 * only when the budget covers it. What must never happen is a truncated payload
 * landing as a finished result — the propose tuple and the grade key are both
 * memoized for good.
 */
describe("propose_takes — truncated extraction", () => {
  const CUT = `[{"claim_text":"the market will`;
  const WHOLE = `[{"claim_text":"the market will fall","kind":"prediction","weight":0.7}]`;

  it("retries once at a LARGER cap and keeps what the second call returned", async () => {
    await seedDoc("d1", "Q".repeat(500));
    const { fn, caps } = scriptedLlm([
      { text: CUT, stopReason: STOP_REASON_MAX_TOKENS },
      { text: WHOLE },
    ]);
    const r = await proposeTakesPhase(engine, { llmFn: fn });
    expect(caps).toEqual([1200, 2400]); // never the same cap twice
    expect(r.takesQueued).toBe(1);
    expect(r.errors).toEqual([]);
    const { rows } = await engine.query<{ claim_text: string }>(
      `SELECT claim_text FROM synth_takes`,
    );
    expect(rows[0]?.claim_text).toBe("the market will fall");
  });

  it("still truncated → nothing memoized, and the error names the cap", async () => {
    await seedDoc("d1", "Q".repeat(500));
    const { fn, caps } = scriptedLlm([{ text: CUT, stopReason: STOP_REASON_MAX_TOKENS }]);
    const r = await proposeTakesPhase(engine, { llmFn: fn });
    expect(caps.length).toBe(2); // one retry, not a loop
    expect(r.takesQueued).toBe(0);
    expect(r.tombstonesWritten).toBe(0);
    expect(r.errors[0]).toContain("truncated");
    // No row at all — not even the zero-yield tombstone, which would tell
    // discovery this document is done.
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_takes`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
    // ...so once the failure backoff runs out, a run picks the document up again.
    await expireBackoff();
    const again = await proposeTakesPhase(engine, {
      llmFn: scriptedLlm([{ text: WHOLE }]).fn,
    });
    expect(again.documentsScanned).toBe(1);
    expect(again.takesQueued).toBe(1);
  });
});

describe("grade_takes — truncated single judge", () => {
  async function seedTake(claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ('tk-1', 'd1', 'h', 'v1-nova', $1, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
      [claim],
    );
  }

  const CUT = `{"verdict":"corr`;
  const WHOLE = `{"verdict":"correct","confidence":0.9,"reasoning":"matches"}`;

  it("retries once at a LARGER cap and grades on the second answer", async () => {
    await seedTake("the claim");
    const { fn, caps } = scriptedLlm([
      { text: CUT, stopReason: STOP_REASON_MAX_TOKENS },
      { text: WHOLE },
    ]);
    const r = await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: fn });
    expect(caps).toEqual([500, 1000]);
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ verdict: string }>(
      `SELECT verdict FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("correct");
  });

  it("still truncated → no grade row, and the take stays in the pool", async () => {
    await seedTake("the claim");
    const { fn } = scriptedLlm([{ text: CUT, stopReason: STOP_REASON_MAX_TOKENS }]);
    const r = await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: fn });
    // NOT the unresolvable parse-failure row: that row keys (take_id,
    // prompt_version, evidence_sig) and would retire the take over a ceiling
    // the operator can raise.
    expect(r.gradesWritten).toBe(0);
    expect(r.errors[0]).toContain("truncated");
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
    const { rows: takes } = await engine.query<{ status: string }>(
      `SELECT status FROM synth_takes`,
    );
    expect(takes[0]?.status).toBe("queued");
    // Re-graded next run once the answer fits.
    const again = await gradeTakesPhase(engine, {
      evidenceFn: async () => "e",
      llmFn: scriptedLlm([{ text: WHOLE }]).fn,
    });
    expect(again.takesScanned).toBe(1);
    expect(again.gradesWritten).toBe(1);
  });

  it("a truncated response that still closed its verdict is kept", async () => {
    await seedTake("the claim");
    // The object parsed — the cut fell after it, on trailing prose. Nothing the
    // grade needs was lost, so this is a verdict, not a failure.
    const { fn } = scriptedLlm([
      { text: `${WHOLE}\n\nNotes on the reason`, stopReason: STOP_REASON_MAX_TOKENS },
    ]);
    const r = await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: fn });
    expect(r.gradesWritten).toBe(1);
  });
});

describe("gradeTakeEnsemble — a truncated judge respects the shared budget", () => {
  const CUT = `{"verdict":"corr`;
  const WHOLE = `{"verdict":"correct","confidence":0.9,"reasoning":"r"}`;

  it("buys more room for a cut judge and prices BOTH calls", async () => {
    const { fn, caps } = scriptedSonnet([
      { text: CUT, stopReason: STOP_REASON_MAX_TOKENS },
      { text: WHOLE },
    ]);
    const budget = new BudgetTracker(1, "test");
    const r = await gradeTakeEnsemble("claim", "evidence", {
      sonnetFn: fn,
      budget,
      judges: 1,
    });
    expect(caps).toEqual([500, 1000]);
    expect(r.grade?.verdict).toBe("correct");
    expect(r.truncatedJudges).toBe(0);
    // 2 x {100 in, 50 out} on Sonnet — the retry is not a free call.
    expect(budget.totalSpent()).toBeCloseTo(
      costUsd("eu.anthropic.claude-sonnet-4-6", { inputTokens: 200, outputTokens: 100 }),
      10,
    );
  });

  it("skips the enlarged retry when it would blow the cap, and reports the cut", async () => {
    const { fn, caps } = scriptedSonnet([{ text: CUT, stopReason: STOP_REASON_MAX_TOKENS }]);
    // Room for one judge, not for the doubled-output retry on top of it.
    const budget = new BudgetTracker(0.01, "test");
    const r = await gradeTakeEnsemble("claim", "evidence", {
      sonnetFn: fn,
      budget,
      judges: 1,
    });
    expect(caps).toEqual([500]); // paying twice for the identical cut is the bug
    expect(r.callsMade).toBe(1);
    expect(r.truncatedJudges).toBe(1);
    expect(r.grade).toBeNull();
  });
});
