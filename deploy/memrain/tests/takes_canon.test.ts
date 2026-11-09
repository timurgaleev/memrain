/**
 * Operator-authored takes canon (migrations 090/091 + takes-canon.ts):
 * fence→DB sync, the resolution tuple, gated auto-resolve, and the
 * takes-holder allow-list on the read paths. Offline PGLite; injected
 * llmFn/evidenceFn — no Bedrock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putPage } from "../src/core/pages.ts";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  deriveResolutionTuple,
  resolveTake,
  syncTakesFromFence,
  fenceTakeKey,
  FENCE_PROMPT_VERSION,
} from "../src/core/synthesis/takes-canon.ts";
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from "../src/core/synthesis/takes-fence.ts";
import { gradeTakesPhase } from "../src/core/synthesis/takes.ts";
import {
  listTakes,
  searchTakes,
  getTakesScorecard,
  getTakesCalibration,
} from "../src/core/synthesis/reads.ts";
import { effectiveTakesHolders } from "../src/core/auth-info.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-takes-canon-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake" });

function fenceBody(rows: string[]): string {
  return [
    "# Page",
    "",
    "## Takes",
    "",
    TAKES_FENCE_BEGIN,
    "| # | claim | kind | who | weight | since | source |",
    "|---|-------|------|-----|--------|-------|--------|",
    ...rows,
    TAKES_FENCE_END,
    "",
  ].join("\n");
}

async function seedLlmTake(key: string, opts: { holder?: string; ageDays?: number; weight?: number } = {}): Promise<void> {
  await engine.query("INSERT INTO documents (id,source_path,source_id) VALUES ('doc-x','/vault/doc-x.md','default') ON CONFLICT (id) DO NOTHING");
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, holder, generated_at)
     VALUES ($1, 'doc-x', 'h', 'v', $2, 'prediction', $3, 'queued', 'm', $4, now() - ($5 * interval '1 day'))`,
    [key, `claim ${key}`, opts.weight ?? 0.7, opts.holder ?? "brain", opts.ageDays ?? 200],
  );
}

describe("deriveResolutionTuple", () => {
  it("derives outcome from quality", () => {
    expect(deriveResolutionTuple({ quality: "correct" })).toEqual({ quality: "correct", outcome: true });
    expect(deriveResolutionTuple({ quality: "incorrect" })).toEqual({ quality: "incorrect", outcome: false });
    expect(deriveResolutionTuple({ quality: "partial" })).toEqual({ quality: "partial", outcome: null });
    expect(deriveResolutionTuple({ quality: "unresolvable" })).toEqual({ quality: "unresolvable", outcome: null });
  });
  it("back-compat: outcome alone maps to correct/incorrect", () => {
    expect(deriveResolutionTuple({ outcome: true })).toEqual({ quality: "correct", outcome: true });
    expect(deriveResolutionTuple({ outcome: false })).toEqual({ quality: "incorrect", outcome: false });
  });
  it("throws on neither or on a contradiction", () => {
    expect(() => deriveResolutionTuple({})).toThrow(/either/);
    expect(() => deriveResolutionTuple({ quality: "correct", outcome: false })).toThrow(/contradicts/);
    expect(() => deriveResolutionTuple({ quality: "partial", outcome: true })).toThrow(/contradicts/);
  });
});

describe("syncTakesFromFence", () => {
  it("derives synth_takes rows from a page fence (operator canon)", async () => {
    const body = fenceBody([
      "| 1 | Alpha will win | bet | people/alex-chen | 0.85 | 2026-01 | memo |",
      "| 2 | ~~Beta is dead~~ | take | world | 0.6 | 2025-01 → 2026-01 | |",
    ]);
    await putPage(storage, { slug: "page-canon", markdown_body: body });
    const r = await syncTakesFromFence(engine, "page-canon", body);
    expect(r.rowsUpserted).toBe(2);
    expect(r.warnings).toEqual([]);

    const rows = await listTakes(engine, { status: "accepted" });
    const alpha = rows.find((t) => t.claim_text === "Alpha will win")!;
    expect(alpha.holder).toBe("people/alex-chen");
    expect(alpha.kind).toBe("bet");
    expect(alpha.active).toBe(true);
    const beta = rows.find((t) => t.claim_text === "Beta is dead")!;
    expect(beta.active).toBe(false);

    const { rows: raw } = await engine.query<{ prompt_version: string; row_num: number; since_date: string; until_date: string }>(
      `SELECT prompt_version, row_num, since_date, until_date FROM synth_takes WHERE take_key = $1`,
      [fenceTakeKey("page-canon", 2)],
    );
    expect(raw[0]!.prompt_version).toBe(FENCE_PROMPT_VERSION);
    expect(raw[0]!.row_num).toBe(2);
    expect(raw[0]!.since_date).toBe("2025-01");
    expect(raw[0]!.until_date).toBe("2026-01");
  });

  it("re-sync updates in place and deactivates vanished rows", async () => {
    const v1 = fenceBody([
      "| 1 | First claim | take | world | 0.5 | | |",
      "| 2 | Second claim | take | world | 0.5 | | |",
    ]);
    await syncTakesFromFence(engine, "page-resync", v1);
    // Row 2 hand-deleted; row 1 claim edited in place.
    const v2 = fenceBody(["| 1 | First claim, sharpened | take | world | 0.65 | | |"]);
    const r = await syncTakesFromFence(engine, "page-resync", v2);
    expect(r.rowsUpserted).toBe(1);
    expect(r.rowsDeactivated).toBe(1);

    const { rows } = await engine.query<{ claim_text: string; active: boolean; weight: number }>(
      `SELECT claim_text, active, weight FROM synth_takes WHERE source_ref = 'page-resync' ORDER BY row_num`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.claim_text).toBe("First claim, sharpened");
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.weight).toBeCloseTo(0.65, 5);
    expect(rows[1]!.active).toBe(false);
  });

  it("clamps out-of-range fence weights at the write layer", async () => {
    const body = fenceBody(["| 1 | Overweight | bet | world | 1.9 | | |"]);
    const r = await syncTakesFromFence(engine, "page-clamp", body);
    expect(r.weightsClamped).toBe(1);
    const { rows } = await engine.query<{ weight: number }>(
      `SELECT weight FROM synth_takes WHERE source_ref = 'page-clamp'`,
    );
    expect(rows[0]!.weight).toBe(1);
  });

  it("syncs inline resolution columns onto the row", async () => {
    const body = [
      TAKES_FENCE_BEGIN,
      "| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |",
      "|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|",
      "| 1 | Hit $10M | bet | world | 0.7 | 2025-01 | plan | 2026-06-01 | incorrect | Q2 miss | 6 | musd | operator |",
      TAKES_FENCE_END,
    ].join("\n");
    await syncTakesFromFence(engine, "page-resolved", body);
    const { rows } = await engine.query<{
      resolved_quality: string;
      resolved_outcome: boolean;
      resolved_value: number;
      resolved_by: string;
    }>(
      `SELECT resolved_quality, resolved_outcome, resolved_value, resolved_by
         FROM synth_takes WHERE source_ref = 'page-resolved'`,
    );
    expect(rows[0]).toMatchObject({
      resolved_quality: "incorrect",
      resolved_outcome: false,
      resolved_value: 6,
      resolved_by: "operator",
    });
  });

  it("is a no-op on a body without a fence", async () => {
    const r = await syncTakesFromFence(engine, "page-nofence", "just prose");
    expect(r.rowsUpserted).toBe(0);
    expect(r.rowsDeactivated).toBe(0);
  });
});

describe("resolveTake", () => {
  it("writes the resolution tuple onto an active take", async () => {
    await seedLlmTake("resolve-me");
    const r = await resolveTake(engine, "resolve-me", {
      quality: "correct",
      value: 42,
      unit: "pct",
      source: "the operator checked",
      resolvedBy: "operator",
    });
    expect(r.resolved).toBe(true);
    const { rows } = await engine.query<{
      resolved_quality: string;
      resolved_outcome: boolean;
      resolved_value: number;
      resolved_unit: string;
      resolved_by: string;
      resolved_at: string;
    }>(
      `SELECT resolved_quality, resolved_outcome, resolved_value, resolved_unit, resolved_by, resolved_at::text AS resolved_at
         FROM synth_takes WHERE take_key = 'resolve-me'`,
    );
    expect(rows[0]).toMatchObject({
      resolved_quality: "correct",
      resolved_outcome: true,
      resolved_value: 42,
      resolved_unit: "pct",
      resolved_by: "operator",
    });
    expect(rows[0]!.resolved_at).toBeTruthy();
  });

  it("onlyIfUnresolved never overwrites an existing resolution", async () => {
    const r = await resolveTake(
      engine,
      "resolve-me",
      { quality: "incorrect", resolvedBy: "machine" },
      { onlyIfUnresolved: true },
    );
    expect(r.resolved).toBe(false);
    const { rows } = await engine.query<{ resolved_quality: string }>(
      `SELECT resolved_quality FROM synth_takes WHERE take_key = 'resolve-me'`,
    );
    expect(rows[0]!.resolved_quality).toBe("correct");
  });

  it("tenant scope: a cross-tenant resolve is a silent no-op", async () => {
    await seedLlmTake("scoped-take");
    const r = await resolveTake(
      engine,
      "scoped-take",
      { quality: "correct" },
      { sourceIds: ["someone-else"] },
    );
    expect(r.resolved).toBe(false);
  });
});

describe("gated auto-resolve in gradeTakesPhase", () => {
  it("OFF by default: a high-confidence verdict stays advisory", async () => {
    await seedLlmTake("no-auto");
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "e",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.99,"reasoning":"sure"}`),
    });
    expect(r.autoApplied).toBe(0);
    const { rows } = await engine.query<{ resolved_quality: string | null }>(
      `SELECT resolved_quality FROM synth_takes WHERE take_key = 'no-auto'`,
    );
    expect(rows[0]!.resolved_quality).toBeNull();
  });

  it("ON: applies a verdict at/above the threshold with the machine stamp", async () => {
    await seedLlmTake("auto-hit");
    const r = await gradeTakesPhase(engine, {
      autoResolve: true,
      promptVersion: "auto-v1",
      evidenceFn: async () => "e",
      llmFn: fakeLlm(`{"verdict":"incorrect","confidence":0.97,"reasoning":"clear miss"}`),
    });
    // The phase grades every eligible take in the shared DB; at least this one applied.
    expect(r.autoApplied).toBeGreaterThanOrEqual(1);
    const { rows } = await engine.query<{
      resolved_quality: string;
      resolved_by: string;
      resolved_source: string;
    }>(
      `SELECT resolved_quality, resolved_by, resolved_source FROM synth_takes WHERE take_key = 'auto-hit'`,
    );
    expect(rows[0]).toMatchObject({
      resolved_quality: "incorrect",
      resolved_by: "memrain:grade_takes",
      resolved_source: "grade_takes:auto-v1",
    });
  });

  it("ON: a verdict below the bar does not apply", async () => {
    await seedLlmTake("auto-low");
    const r = await gradeTakesPhase(engine, {
      autoResolve: true,
      promptVersion: "auto-v2",
      evidenceFn: async () => "e",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.8,"reasoning":"probably"}`),
    });
    expect(r.autoApplied).toBe(0);
    const { rows } = await engine.query<{ resolved_quality: string | null }>(
      `SELECT resolved_quality FROM synth_takes WHERE take_key = 'auto-low'`,
    );
    expect(rows[0]!.resolved_quality).toBeNull();
  });

  it("ON: 'unresolvable' never applies, at any confidence", async () => {
    await seedLlmTake("auto-unres");
    const r = await gradeTakesPhase(engine, {
      autoResolve: true,
      promptVersion: "auto-v3",
      evidenceFn: async () => "e",
      llmFn: fakeLlm(`{"verdict":"unresolvable","confidence":0.99,"reasoning":"no evidence"}`),
    });
    expect(r.autoApplied).toBe(0);
  });

  it("ON: never overwrites a human resolution", async () => {
    await seedLlmTake("auto-human");
    await resolveTake(engine, "auto-human", { quality: "partial", resolvedBy: "operator" });
    await gradeTakesPhase(engine, {
      autoResolve: true,
      promptVersion: "auto-v4",
      evidenceFn: async () => "e",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.99,"reasoning":"sure"}`),
    });
    const { rows } = await engine.query<{ resolved_quality: string; resolved_by: string }>(
      `SELECT resolved_quality, resolved_by FROM synth_takes WHERE take_key = 'auto-human'`,
    );
    expect(rows[0]).toMatchObject({ resolved_quality: "partial", resolved_by: "operator" });
  });
});

describe("takes-holder allow-list on the read paths", () => {
  beforeAll(async () => {
    await seedLlmTake("holder-world", { holder: "world" });
    await seedLlmTake("holder-person", { holder: "people/alex-chen" });
  });

  it("listTakes filters by the allow-list; unscoped sees everything", async () => {
    const scoped = await listTakes(engine, { holderAllowList: ["world"], limit: 200 });
    expect(scoped.some((t) => t.take_key === "holder-world")).toBe(true);
    expect(scoped.some((t) => t.take_key === "holder-person")).toBe(false);
    expect(scoped.every((t) => t.holder === "world")).toBe(true);

    const unscoped = await listTakes(engine, { limit: 200 });
    expect(unscoped.some((t) => t.take_key === "holder-person")).toBe(true);
  });

  it("listTakes single-holder filter works alongside the allow-list", async () => {
    const rows = await listTakes(engine, { holder: "people/alex-chen", limit: 200 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((t) => t.holder === "people/alex-chen")).toBe(true);
  });

  it("searchTakes honors the allow-list", async () => {
    const scoped = await searchTakes(engine, {
      q: "claim holder",
      holderAllowList: ["world"],
      limit: 200,
    });
    expect(scoped.every((t) => t.holder === "world")).toBe(true);
    expect(scoped.some((t) => t.take_key === "holder-world")).toBe(true);
  });

  it("scorecard scopes to allowed holders", async () => {
    const all = await getTakesScorecard(engine);
    const worldOnly = await getTakesScorecard(engine, { holderAllowList: ["world"] });
    expect(worldOnly.total_takes).toBeLessThan(all.total_takes);
  });

  it("effectiveTakesHolders: operator unscoped, remote floored to world, * escape hatch", () => {
    expect(effectiveTakesHolders(undefined)).toBeUndefined();
    const base = { token: "t", clientId: "c", scopes: [], isPublic: false };
    // Fail-safe: a REMOTE credential without the knob is floored to ['world']
    // (fail-closed) — only the operator path is unscoped by absence.
    expect(effectiveTakesHolders({ ...base })).toEqual(["world"]);
    expect(effectiveTakesHolders({ ...base, takesHolders: [] })).toEqual(["world"]);
    expect(effectiveTakesHolders({ ...base, takesHolders: ["world", "world"] })).toEqual(["world"]);
    expect(effectiveTakesHolders({ ...base, takesHolders: ["world", "*"] })).toBeUndefined();
  });
});

describe("calibration measures the human first", () => {
  it("the resolution tuple overrides the judge grade in scorecard + calibration", async () => {
    // A take the judge called 'correct' but the human resolved 'incorrect'.
    await seedLlmTake("human-wins", { weight: 0.9 });
    const { rows: idRows } = await engine.query<{ id: number }>(
      `SELECT id FROM synth_takes WHERE take_key = 'human-wins'`,
    );
    await engine.query(
      `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
       VALUES ($1, 'v', 'sig-hw', 'correct', 0.9, 'fake')`,
      [idRows[0]!.id],
    );
    const before = await getTakesScorecard(engine, { holderAllowList: undefined });
    await resolveTake(engine, "human-wins", { quality: "incorrect", resolvedBy: "operator" });
    const after = await getTakesScorecard(engine);
    expect(after.incorrect).toBe(before.incorrect + 1);
    expect(after.correct).toBe(before.correct - 1);

    // The calibration curve also scores the human verdict: weight 0.9, miss.
    const buckets = await getTakesCalibration(engine, { holderAllowList: ["brain"] });
    const hi = buckets.find((b) => b.bucket_lo > 0.85 && b.bucket_lo < 0.95);
    expect(hi).toBeDefined();
    expect(hi!.observed).toBe(0);
  });

  it("a human-resolved take with NO judge grade still counts", async () => {
    await seedLlmTake("ungraded-resolved", { weight: 0.5, holder: "world" });
    await resolveTake(engine, "ungraded-resolved", { quality: "correct", resolvedBy: "operator" });
    const s = await getTakesScorecard(engine, { holderAllowList: ["world"] });
    expect(s.correct).toBeGreaterThanOrEqual(1);
    expect(s.resolved).toBeGreaterThanOrEqual(1);
  });
});
