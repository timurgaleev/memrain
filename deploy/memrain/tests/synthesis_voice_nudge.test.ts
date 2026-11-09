/**
 * G31 calibration UX — voice gate + take-commit nudge. Hermetic (no Bedrock):
 * the gate's judge and generators are injected fakes; the nudge is
 * deterministic template text over seeded rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  gateVoice,
  parseVoiceJudgeOutput,
} from "../src/core/synthesis/voice-gate.ts";
import {
  evaluateNudgeRule,
  evaluateAndFireNudge,
  nudgeOnTakeCommit,
  resetNudgeCooldown,
  loadNudgeProfile,
} from "../src/core/synthesis/nudge.ts";
import { calibrationProfilePhase } from "../src/core/synthesis/calibration.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-voice-nudge-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseVoiceJudgeOutput", () => {
  it("parses a verdict and clamps the reason", () => {
    const v = parseVoiceJudgeOutput(`{"verdict":"conversational","reason":"warm"}`);
    expect(v.verdict).toBe("conversational");
    expect(v.reason).toBe("warm");
  });
  it("treats unparseable output as academic (falls back to template)", () => {
    expect(parseVoiceJudgeOutput("nonsense").verdict).toBe("academic");
    expect(parseVoiceJudgeOutput("").verdict).toBe("academic");
  });
});

describe("gateVoice", () => {
  const judgeLlm = (verdicts: string[]): LlmFn => {
    let i = 0;
    return async () => ({
      text: verdicts[Math.min(i++, verdicts.length - 1)]!,
      modelId: "fake-haiku",
    });
  };

  it("accepts a conversational first attempt", async () => {
    const r = await gateVoice({
      mode: "pattern_statement",
      llmFn: judgeLlm([`{"verdict":"conversational","reason":"ok"}`]),
      generate: async () => "You nailed 3 of 5 macro calls.",
      templateFallback: () => "template",
    });
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.text).toContain("nailed");
  });

  it("regenerates with feedback, then accepts", async () => {
    const feedbacks: Array<string | undefined> = [];
    const r = await gateVoice({
      mode: "pattern_statement",
      llmFn: judgeLlm([
        `{"verdict":"academic","reason":"too clinical"}`,
        `{"verdict":"conversational","reason":"ok"}`,
      ]),
      generate: async ({ attempt, feedback }) => {
        feedbacks.push(feedback);
        return `attempt ${attempt}`;
      },
      templateFallback: () => "template",
    });
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(feedbacks[1]).toBe("too clinical");
  });

  it("falls back to the template after two rejections", async () => {
    const r = await gateVoice({
      mode: "pattern_statement",
      llmFn: judgeLlm([`{"verdict":"academic","reason":"nope"}`]),
      generate: async () => "clinical text",
      templateFallback: () => "the template",
    });
    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.text).toBe("the template");
    expect(r.lastReason).toBe("nope");
  });

  it("survives a throwing generator (template fallback, no throw)", async () => {
    const r = await gateVoice({
      mode: "nudge",
      llmFn: judgeLlm([`{"verdict":"conversational","reason":"ok"}`]),
      generate: async () => {
        throw new Error("gen down");
      },
      templateFallback: () => "safe",
    });
    expect(r.passed).toBe(false);
    expect(r.text).toBe("safe");
  });
});

describe("calibration voice-gate audit fields", () => {
  async function seedGraded(n: number): Promise<void> {
    await engine.query("INSERT INTO documents (id,source_path,source_id) VALUES ('d1','/vault/d1.md','default')");
    for (let i = 0; i < n; i++) {
      const { rows } = await engine.query<{ id: number }>(
        `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
         VALUES ($1, 'd1', 'h', 'v1', 'claim', 'm') RETURNING id`,
        [`vg-${i}`],
      );
      await engine.query(
        `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
         VALUES ($1, 'v1', $2, 'correct', 0.8, 'm')`,
        [Number(rows[0]?.id), `sig-${i}`],
      );
    }
  }

  it("records a failed gate (template fallback) on the profile row", async () => {
    await seedGraded(5);
    // Fake returns prose for the generator AND for the judge — the judge parse
    // fails, so every attempt is rejected and the template wins.
    const llm: LlmFn = async () => ({ text: "just prose", modelId: "fake" });
    const r = await calibrationProfilePhase(engine, { llmFn: llm });
    expect(r.profileWritten).toBe(true);
    expect(r.profiles[0]?.voiceGatePassed).toBe(false);
    const { rows } = await engine.query<{ voice_gate_passed: boolean; voice_gate_attempts: number }>(
      `SELECT voice_gate_passed, voice_gate_attempts FROM synth_calibration_profile`,
    );
    expect(rows[0]?.voice_gate_passed).toBe(false);
    expect(Number(rows[0]?.voice_gate_attempts)).toBe(2);
  });

  it("records a passing gate", async () => {
    await seedGraded(5);
    const llm: LlmFn = async (input) => ({
      text: input.system.includes("voice gate")
        ? `{"verdict":"conversational","reason":"ok"}`
        : "You called 5 of 5 — a clean sweep.",
      modelId: "fake",
    });
    const r = await calibrationProfilePhase(engine, { llmFn: llm });
    expect(r.profiles[0]?.voiceGatePassed).toBe(true);
    const { rows } = await engine.query<{ voice_gate_passed: boolean }>(
      `SELECT voice_gate_passed FROM synth_calibration_profile`,
    );
    expect(rows[0]?.voice_gate_passed).toBe(true);
  });
});

describe("take-commit nudge", () => {
  it("evaluateNudgeRule matches high-conviction takes on an active bias tag", () => {
    const profile = { bias_tags: ["over-confident-macro"] };
    expect(
      evaluateNudgeRule({ id: 1, weight: 0.9, domain: "macro" }, profile).matched,
    ).toBe(true);
    expect(
      evaluateNudgeRule({ id: 1, weight: 0.5, domain: "macro" }, profile).reason,
    ).toBe("below_conviction_threshold");
    expect(
      evaluateNudgeRule({ id: 1, weight: 0.9, domain: "geo" }, profile).reason,
    ).toBe("no_matching_bias_tag");
    expect(evaluateNudgeRule({ id: 1, weight: 0.9, domain: "macro" }, null).reason).toBe(
      "no_profile",
    );
  });

  it("fires once, logs, then cools down for 14 days; reset re-arms", async () => {
    const out: string[] = [];
    const stderr = { write: (s: string) => void out.push(s) };
    const take = { id: 7, weight: 0.9, domain: "macro" };
    const profile = { bias_tags: ["over-confident-macro"] };

    const first = await evaluateAndFireNudge({ engine, take, profile, sourceId: null, stderr });
    expect(first.shouldFire).toBe(true);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("over-confident-macro");

    const second = await evaluateAndFireNudge({ engine, take, profile, sourceId: null, stderr });
    expect(second.shouldFire).toBe(false);
    expect(second.reason).toBe("cooldown_active");
    expect(out.length).toBe(1);

    const { deleted } = await resetNudgeCooldown(engine, 7);
    expect(deleted).toBe(1);
    const third = await evaluateAndFireNudge({ engine, take, profile, sourceId: null, stderr });
    expect(third.shouldFire).toBe(true);
  });

  it("nudgeOnTakeCommit loads take + latest tenant profile and fires end-to-end", async () => {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, weight, domain, model_id)
       VALUES ('nudge-e2e', 'doc-x', 'h', 'v1', 'big macro bet', 0.85, 'macro', 'm')`,
    );
    // No documents row for 'doc-x' → the take's tenant coalesces to the
    // 'default' legacy bucket, same as the calibration writer.
    await engine.query(
      `INSERT INTO synth_calibration_profile (total_graded, bias_tags, model_id)
       VALUES (5, '["over-confident-macro"]'::jsonb, 'm')`,
    );
    const profile = await loadNudgeProfile(engine, null);
    expect(profile?.bias_tags).toEqual(["over-confident-macro"]);

    const out: string[] = [];
    const d = await nudgeOnTakeCommit(engine, "nudge-e2e", {
      stderr: { write: (s) => void out.push(s) },
    });
    expect(d.shouldFire).toBe(true);
    const { rows } = await engine.query<{ nudge_pattern: string }>(
      `SELECT nudge_pattern FROM take_nudge_log`,
    );
    expect(rows[0]?.nudge_pattern).toBe("over-confident-macro");
  });
});
