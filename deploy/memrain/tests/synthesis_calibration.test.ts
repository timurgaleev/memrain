/**
 * calibration_profile phase tests — hermetic, MOCKED llmFn (no Bedrock).
 * Verifies the scorecard aggregation, the min-graded gate, provenance, and
 * fail-open template fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  calibrationProfilePhase,
  parseBiasTags,
  parsePatternStatements,
} from "../src/core/synthesis/calibration.ts";
import { getCalibrationProfile } from "../src/core/synthesis/reads.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-calib-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
  await engine.query("INSERT INTO documents (id,source_path,source_id) VALUES ('d1','/vault/d1.md','default')");
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let takeCounter = 0;
async function seedGradedTake(verdict: string): Promise<void> {
  takeCounter += 1;
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
     VALUES ($1, 'd1', 'h', 'v1-nova', 'claim', 'm') RETURNING id`,
    [`ct-${takeCounter}`],
  );
  await engine.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1-nova', $2, $3, 0.8, 'm')`,
    [Number(rows[0]?.id), `sig-${takeCounter}`, verdict],
  );
}

/** Register a tenant so the profile FK to sources(id) is satisfiable. */
async function seedSource(id: string): Promise<void> {
  await engine.query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2)
       ON CONFLICT (id) DO NOTHING`,
    [id, `__${id}__`],
  );
}

/** Seed a graded take owned by `sourceId` (via its source document). */
async function seedGradedTakeForSource(sourceId: string, verdict: string): Promise<void> {
  takeCounter += 1;
  const docId = `doc-${sourceId}-${takeCounter}`;
  await engine.query(
    `INSERT INTO documents (id, source_path, source_id) VALUES ($1, $2, $3)`,
    [docId, `/x/${docId}.md`, sourceId],
  );
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
     VALUES ($1, $2, 'h', 'v1-nova', 'claim', 'm') RETURNING id`,
    [`ct-${sourceId}-${takeCounter}`, docId],
  );
  await engine.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1-nova', $2, $3, 0.8, 'm')`,
    [Number(rows[0]?.id), `sig-${sourceId}-${takeCounter}`, verdict],
  );
}

/** Seed a graded take with an explicit conviction weight and domain (default
 *  tenant), for Brier + per-domain assertions. Leaves it graded. */
async function seedGradedTakeFull(opts: {
  verdict: string;
  weight: number;
  domain?: string | null;
}): Promise<void> {
  takeCounter += 1;
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, weight, domain, model_id)
     VALUES ($1, 'd1', 'h', 'v1-nova', 'claim', $2, $3, 'm') RETURNING id`,
    [`ct-${takeCounter}`, opts.weight, opts.domain ?? null],
  );
  await engine.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1-nova', $2, $3, 0.8, 'm')`,
    [Number(rows[0]?.id), `sig-${takeCounter}`, opts.verdict],
  );
}

/** Seed an UNGRADED take (default tenant) — pulls grade_completion below 1. */
async function seedUngradedTake(): Promise<void> {
  takeCounter += 1;
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
     VALUES ($1, 'd1', 'h', 'v1-nova', 'claim', 'm')`,
    [`ct-ung-${takeCounter}`],
  );
}

/** JSONB round-trips as a string on some engines; normalise. */
function asJson<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

// The narrative generator now routes pattern statements through the voice
// gate, so the fake must answer the gate's judge prompt too (conversational →
// the generated text is accepted, matching the pre-gate expectations).
const fakeLlm = (text: string): LlmFn => async (input) => ({
  text: input.system.includes("voice gate")
    ? `{"verdict":"conversational","reason":"ok"}`
    : text,
  modelId: "fake-nova",
});

describe("parsers", () => {
  it("parses pattern statements, stripping bullets", () => {
    expect(parsePatternStatements("- one\n2. two\nthree")).toEqual(["one", "two", "three"]);
  });
  it("parses kebab-case bias tags only", () => {
    expect(parseBiasTags(`["over-confident-macro","BAD TAG","late-on-hiring"]`)).toEqual([
      "over-confident-macro",
      "late-on-hiring",
    ]);
  });
});

describe("calibrationProfilePhase", () => {
  it("skips when below the min-graded gate", async () => {
    await seedGradedTake("correct");
    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("x") });
    expect(r.profileWritten).toBe(false);
    expect(r.skippedReason).toBe("insufficient_data");
  });

  it("writes a profile with scorecard + provenance once enough takes are graded", async () => {
    await seedGradedTake("correct");
    await seedGradedTake("correct");
    await seedGradedTake("correct");
    await seedGradedTake("incorrect");
    await seedGradedTake("partial");

    const r = await calibrationProfilePhase(engine, {
      llmFn: fakeLlm("You called macro well — 3 of 5 held up."),
    });
    expect(r.profileWritten).toBe(true);
    expect(r.totalGraded).toBe(5);
    // accuracy = (correct + 0.5*partial) / resolved = (3 + 0.5) / 5 = 0.7
    expect(r.accuracy).toBeCloseTo(0.7, 5);
    expect(r.patternStatements.length).toBeGreaterThan(0);

    const { rows } = await engine.query<{
      total_graded: number;
      correct: number;
      graded_take_ids: unknown;
      model_id: string;
    }>(`SELECT total_graded, correct, graded_take_ids, model_id FROM synth_calibration_profile`);
    expect(Number(rows[0]?.total_graded)).toBe(5);
    expect(Number(rows[0]?.correct)).toBe(3);
    expect(rows[0]?.model_id).toBe("fake-nova");
    const ids = rows[0]?.graded_take_ids;
    const parsed = typeof ids === "string" ? JSON.parse(ids) : ids;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(5);
  });

  it("fails open — LLM error falls back to a template profile", async () => {
    for (let i = 0; i < 5; i++) await seedGradedTake("correct");
    const boom: LlmFn = async () => {
      throw new Error("nova down");
    };
    const r = await calibrationProfilePhase(engine, { llmFn: boom });
    expect(r.profileWritten).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.patternStatements.length).toBe(1); // template fallback
  });
});

describe("per-source calibration (tenancy)", () => {
  it("writes one profile per source; a scoped read returns only that source, no blend", async () => {
    await seedSource("tenant-a");
    await seedSource("tenant-b");
    // tenant-a: a strong track record; tenant-b: a weak one.
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-a", "correct");
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-b", "incorrect");

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    expect(r.profileWritten).toBe(true);
    expect(r.profiles.length).toBe(2);

    const a = await getCalibrationProfile(engine, ["tenant-a"]);
    const b = await getCalibrationProfile(engine, ["tenant-b"]);
    expect(a?.source_id).toBe("tenant-a");
    expect(a?.total_graded).toBe(5);
    expect(a?.accuracy).toBeCloseTo(1.0, 5); // 5/5 correct — never blended with b
    expect(b?.source_id).toBe("tenant-b");
    expect(b?.total_graded).toBe(5);
    expect(b?.accuracy).toBeCloseTo(0.0, 5); // 0/5 correct — never blended with a
  });

  it("excludes other tenants' profiles fail-closed for a scoped caller", async () => {
    await seedSource("tenant-a");
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-a", "correct");
    await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });

    // A caller scoped to a tenant with no profile sees nothing — not tenant-a's.
    const other = await getCalibrationProfile(engine, ["tenant-z"]);
    expect(other).toBeNull();
  });
});

describe("calibration depth (Brier, partial_rate, grade_completion)", () => {
  it("computes Brier over decided takes' conviction vs outcome", async () => {
    // Decided (correct/incorrect) contribute (weight - outcome)²; partial is
    // excluded from Brier but still counted for partial_rate.
    await seedGradedTakeFull({ verdict: "correct", weight: 0.9 }); // (0.9-1)² = 0.01
    await seedGradedTakeFull({ verdict: "correct", weight: 0.8 }); // (0.8-1)² = 0.04
    await seedGradedTakeFull({ verdict: "incorrect", weight: 0.2 }); // (0.2-0)² = 0.04
    await seedGradedTakeFull({ verdict: "incorrect", weight: 0.7 }); // (0.7-0)² = 0.49
    await seedGradedTakeFull({ verdict: "partial", weight: 0.5 }); // excluded

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    expect(r.profileWritten).toBe(true);
    const p = r.profiles[0];
    // Brier = (0.01 + 0.04 + 0.04 + 0.49) / 4 = 0.145
    expect(p?.brier).toBeCloseTo(0.145, 6);
    // partial_rate = partial / resolved = 1 / 5 = 0.2
    expect(p?.partialRate).toBeCloseTo(0.2, 6);

    const { rows } = await engine.query<{ brier: number; partial_rate: number }>(
      `SELECT brier, partial_rate FROM synth_calibration_profile`,
    );
    expect(Number(rows[0]?.brier)).toBeCloseTo(0.145, 6);
    expect(Number(rows[0]?.partial_rate)).toBeCloseTo(0.2, 6);
  });

  it("records grade_completion = graded / total takes for the tenant", async () => {
    for (let i = 0; i < 5; i++) await seedGradedTakeFull({ verdict: "correct", weight: 0.7 });
    await seedUngradedTake(); // 5 graded of 6 total → 0.8333…

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    const p = r.profiles[0];
    expect(p?.gradeCompletion).toBeCloseTo(5 / 6, 6);

    const { rows } = await engine.query<{ grade_completion: number }>(
      `SELECT grade_completion FROM synth_calibration_profile`,
    );
    expect(Number(rows[0]?.grade_completion)).toBeCloseTo(5 / 6, 6);
  });

  it("null Brier when no take is decided (all partial/unresolvable)", async () => {
    for (let i = 0; i < 3; i++) await seedGradedTakeFull({ verdict: "partial", weight: 0.5 });
    for (let i = 0; i < 2; i++) await seedGradedTakeFull({ verdict: "unresolvable", weight: 0.5 });

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    const p = r.profiles[0];
    expect(p?.brier).toBeNull();
    // resolved = 3 partial; partial_rate = 3/3 = 1
    expect(p?.partialRate).toBeCloseTo(1, 6);
  });
});

describe("per-domain scorecards", () => {
  it("splits the scorecard by take domain", async () => {
    // macro: 2 correct + 1 incorrect; geo: 2 correct. Total 5 clears the gate.
    await seedGradedTakeFull({ verdict: "correct", weight: 0.9, domain: "macro" });
    await seedGradedTakeFull({ verdict: "correct", weight: 0.8, domain: "macro" });
    await seedGradedTakeFull({ verdict: "incorrect", weight: 0.6, domain: "macro" });
    await seedGradedTakeFull({ verdict: "correct", weight: 0.7, domain: "geo" });
    await seedGradedTakeFull({ verdict: "correct", weight: 0.5, domain: "geo" });

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    const ds = r.profiles[0]?.domainScorecards ?? {};
    expect(Object.keys(ds).sort()).toEqual(["geo", "macro"]);

    expect(ds.macro?.n).toBe(3);
    expect(ds.macro?.correct).toBe(2);
    expect(ds.macro?.incorrect).toBe(1);
    // accuracy = correct / decided = 2 / 3
    expect(ds.macro?.accuracy).toBeCloseTo(2 / 3, 6);
    // Brier = ((0.9-1)² + (0.8-1)² + (0.6-0)²) / 3 = (0.01 + 0.04 + 0.36)/3
    expect(ds.macro?.brier).toBeCloseTo(0.41 / 3, 6);

    expect(ds.geo?.n).toBe(2);
    expect(ds.geo?.accuracy).toBeCloseTo(1, 6);

    // Persisted to the JSONB column and surfaced by the read.
    const profile = await getCalibrationProfile(engine);
    const persisted = asJson<Record<string, { n: number }>>(profile?.domain_scorecards);
    expect(persisted.macro?.n).toBe(3);
    expect(profile?.brier).not.toBeNull();
    expect(profile?.partial_rate).not.toBeNull();
    expect(Number(profile?.grade_completion)).toBeCloseTo(1, 6);
  });

  it("buckets NULL-domain takes under 'unclassified'", async () => {
    for (let i = 0; i < 5; i++) await seedGradedTakeFull({ verdict: "correct", weight: 0.6 });

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    const ds = r.profiles[0]?.domainScorecards ?? {};
    expect(Object.keys(ds)).toEqual(["unclassified"]);
    expect(ds.unclassified?.n).toBe(5);
  });
});
