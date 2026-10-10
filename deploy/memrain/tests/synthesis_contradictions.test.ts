/**
 * Latent-contradiction probe (Item 3) — hermetic, injected SonnetFn (no
 * Bedrock). Covers the default-OFF gate, parse tolerance, cache, budget gate,
 * store-only-on-contradiction, and the MCP read (listProbedContradictions).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  probeContradictionsPhase,
  parseJudgment,
  pairKey,
  latestContradictionRun,
  PROBE_CONTRADICTIONS_PROMPT_VERSION,
  type CandidatePair,
} from "../src/core/synthesis/contradictions.ts";
import { listProbedContradictions } from "../src/core/insights.ts";
import { addFact } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { BudgetTracker } from "../src/core/budget.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-contra-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeSonnet = (text: string): SonnetFn => async () => ({
  text,
  modelId: "eu.anthropic.claude-sonnet-4-6",
  usage: { inputTokens: 100, outputTokens: 40 },
});

const pair = (a: string, b: string, source: string | null = "tenantA"): CandidatePair => ({
  a_ref: a,
  a_text: `claim ${a}`,
  b_ref: b,
  b_text: `claim ${b}`,
  source_id: source,
});

/** Run with the paid-probe gate on, so the real defaultPairs SQL is exercised. */
async function withProbeOn<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MEMRAIN_PROBE_CONTRADICTIONS;
  process.env.MEMRAIN_PROBE_CONTRADICTIONS = "1";
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.MEMRAIN_PROBE_CONTRADICTIONS = prev;
    else delete process.env.MEMRAIN_PROBE_CONTRADICTIONS;
  }
}

const CONTRADICTS = JSON.stringify({
  contradicts: true,
  severity: "high",
  axis: "value",
  confidence: 0.82,
  resolution_command: "forget_fact 2",
});

describe("parseJudgment", () => {
  it("parses a clean object and clamps confidence", () => {
    const j = parseJudgment(`{"contradicts":true,"severity":"medium","axis":"timing","confidence":1.4,"resolution_command":"x"}`);
    expect(j).not.toBeNull();
    expect(j!.contradicts).toBe(true);
    expect(j!.confidence).toBe(1);
    expect(j!.severity).toBe("medium");
  });
  it("defaults an unknown severity to low", () => {
    const j = parseJudgment(`{"contradicts":false,"severity":"nuclear","confidence":0.1}`);
    expect(j!.severity).toBe("low");
  });
  it("returns null when contradicts is missing", () => {
    expect(parseJudgment(`{"severity":"low"}`)).toBeNull();
    expect(parseJudgment("not json")).toBeNull();
  });
});

describe("probeContradictionsPhase", () => {
  it("stores a suspected contradiction and reads it back scoped", async () => {
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(CONTRADICTS),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(r.judged).toBe(1);
    expect(r.contradictionsFound).toBe(1);

    const found = await listProbedContradictions(storage, { sourceIds: ["tenantA"] });
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.axis).toBe("value");

    // A foreign tenant sees nothing (fail-closed scope).
    expect(await listProbedContradictions(storage, { sourceIds: ["other"] })).toHaveLength(0);
  });

  it("does NOT store a non-contradiction", async () => {
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(JSON.stringify({ contradicts: false, severity: "low", confidence: 0.2 })),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(r.judged).toBe(1);
    expect(r.contradictionsFound).toBe(0);
    expect(await listProbedContradictions(storage)).toHaveLength(0);
  });

  it("caches: a pair already stored is not re-judged", async () => {
    let calls = 0;
    const counting: SonnetFn = async () => {
      calls += 1;
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const opts = { sonnetFn: counting, pairsFn: async () => [pair("1", "2")] };
    await probeContradictionsPhase(engine, opts);
    const r2 = await probeContradictionsPhase(engine, opts);
    expect(calls).toBe(1);
    expect(r2.cacheHits).toBe(1);
    expect(r2.judged).toBe(0);
  });

  it("stops before spending when the budget can't fit a pair", async () => {
    let called = false;
    const spy: SonnetFn = async () => {
      called = true;
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: spy,
      budget: new BudgetTracker(0.0000001, "probe-test"),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(called).toBe(false);
    expect(r.budgetExhausted).toBe(true);
    expect(r.contradictionsFound).toBe(0);
  });

  it("counts judge errors and parse failures instead of dropping them or calling them negatives", async () => {
    const MODEL = "eu.anthropic.claude-sonnet-4-6";
    const byPair: SonnetFn = async (input) => {
      if (input.user.includes("claim e1")) throw new Error("ServiceUnavailableException: 503");
      if (input.user.includes("claim p1")) return { text: "I cannot decide.", modelId: MODEL, usage: { inputTokens: 10, outputTokens: 5 } };
      if (input.user.includes("claim n1")) return { text: JSON.stringify({ contradicts: false, severity: "low", confidence: 0.2 }), modelId: MODEL, usage: { inputTokens: 10, outputTokens: 5 } };
      return { text: CONTRADICTS, modelId: MODEL, usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const pairs = [pair("e1", "e2"), pair("p1", "p2"), pair("n1", "n2"), pair("c1", "c2")];
    const r = await probeContradictionsPhase(engine, { sonnetFn: byPair, pairsFn: async () => pairs });
    expect(r.attempted).toBe(4);
    expect(r.judged).toBe(2);
    expect(r.judgeErrors).toBe(1);
    expect(r.parseFailures).toBe(1);
    expect(r.contradictionsFound).toBe(1);
    expect(r.judgeFailed).toBe(true);

    const run = await latestContradictionRun(engine);
    expect(run).toMatchObject({ judged: 2, found: 1, judge_errors: 1, parse_failures: 1, judge_failed: true });

    // The unparseable reply was not cached as a negative verdict; it backs off
    // instead, so the next run re-judges only the pair whose call threw.
    const r2 = await probeContradictionsPhase(engine, { sonnetFn: byPair, pairsFn: async () => pairs });
    expect(r2.cacheHits).toBe(3);
    expect(r2.attempted).toBe(1);
    expect(r2.judgeErrors).toBe(1);
    expect(r2.parseFailures).toBe(0);
    expect(r2.judged).toBe(0);
  });

  it("does not flag a run whose few failures stay within a quarter of its calls", async () => {
    const r = await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(CONTRADICTS),
      pairsFn: async () => [pair("1", "2")],
    });
    expect(r.judgeFailed).toBe(false);
    expect((await latestContradictionRun(engine))?.judge_failed).toBe(false);
  });

  it("shows the judge the day each claim dates from", async () => {
    const seen: string[] = [];
    const capture: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    await probeContradictionsPhase(engine, {
      sonnetFn: capture,
      pairsFn: async () => [
        { ...pair("1", "2"), a_date: "2025-03-01", b_date: "2026-01-15" },
        pair("3", "4"),
      ],
    });
    expect(seen[0]).toBe("A (from: 2025-03-01): claim 1\n\nB (from: 2026-01-15): claim 2");
    expect(seen[1]).toBe("A (date unknown): claim 3\n\nB (date unknown): claim 4");
  });

  it("defaultPairs dates a fact by valid_from, else by the day it was written", async () => {
    await addFact(storage, { entity_slug: "people/bob", fact: "bob is CTO of Acme", valid_from: "2025-03-01" });
    await addFact(storage, { entity_slug: "people/bob", fact: "bob is CEO of Acme" });
    const seen: string[] = [];
    const capture: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    await withProbeOn(() => probeContradictionsPhase(engine, { sonnetFn: capture }));
    const today = (await engine.query<{ d: string }>("SELECT now()::date::text AS d")).rows[0]!.d;
    expect(seen).toEqual([
      `A (from: 2025-03-01): bob is CTO of Acme\n\nB (recorded: ${today}): bob is CEO of Acme`,
    ]);
  });

  it("tells the judge a recorded date is not evidence of when a claim held", async () => {
    let system = "";
    const capture: SonnetFn = async (input) => {
      system = input.system;
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    await probeContradictionsPhase(engine, {
      sonnetFn: capture,
      pairsFn: async () => [{ ...pair("1", "2"), a_date: "2026-01-01", a_date_recorded: true }],
    });
    expect(system).toContain("(recorded: YYYY-MM-DD)");
    expect(system).toContain("only (from:) dates can establish a time-ordered update");
    expect(PROBE_CONTRADICTIONS_PROMPT_VERSION).not.toBe("v2-sonnet");
  });

  it("never pairs a take whose source document is quarantined", async () => {
    const insertTake = (key: string, doc: string, claim: string) =>
      engine.query(
        `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, domain, model_id)
         VALUES ($1, $2, 'h', 'v1', $3, 'markets', 'm')`,
        [key, doc, claim],
      );
    await engine.query(`INSERT INTO documents (id, source_path) VALUES ('q1', '/vault/q1.md'), ('q2', '/vault/q2.md')`);
    await engine.query(
      `INSERT INTO documents (id, source_path, frontmatter) VALUES ('q3', '/vault/q3.md', '{"quarantine": {"patterns": ["x"]}}'::jsonb)`,
    );
    await insertTake("t-1", "q1", "rates will fall next year");
    await insertTake("t-2", "q2", "rates will rise next year");
    await insertTake("t-held", "q3", "rates will triple next year");
    const seen: string[] = [];
    const capture: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const r = await withProbeOn(() => probeContradictionsPhase(engine, { sonnetFn: capture }));
    expect(r.pairsScanned).toBe(1);
    expect(seen.join("\n")).not.toContain("triple");
  });

  it("backs off a pair whose judge reply never parses, without calling it a negative", async () => {
    let calls = 0;
    const garbled: SonnetFn = async () => {
      calls += 1;
      return { text: "I cannot decide.", modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const opts = { sonnetFn: garbled, pairsFn: async () => [pair("g1", "g2")] };
    const expire = () => engine.query(`UPDATE synth_contradiction_verdicts SET expires_at = now() - interval '1 day'`);

    const r1 = await probeContradictionsPhase(engine, opts);
    expect(r1).toMatchObject({ parseFailures: 1, judged: 0 });
    // Within the backoff the pair is not re-judged.
    const r2 = await probeContradictionsPhase(engine, opts);
    expect(calls).toBe(1);
    expect(r2).toMatchObject({ attempted: 0, judged: 0, cacheHits: 1 });
    // After it, a second and third try; then never again.
    await expire();
    await probeContradictionsPhase(engine, opts);
    await expire();
    await probeContradictionsPhase(engine, opts);
    expect(calls).toBe(3);
    await expire();
    const r5 = await probeContradictionsPhase(engine, opts);
    expect(calls).toBe(3);
    expect(r5.judged).toBe(0);
    // A later readable verdict replaces the marker.
    const ok = await probeContradictionsPhase(engine, { ...opts, sonnetFn: fakeSonnet(CONTRADICTS), promptVersion: "other" });
    expect(ok.judged).toBe(1);
  });

  it("defaultPairs never pairs a forgotten or consolidated fact", async () => {
    await addFact(storage, { entity_slug: "people/carol", fact: "carol lives in Oslo" });
    await addFact(storage, { entity_slug: "people/carol", fact: "carol lives in Bergen" });
    const gone = await addFact(storage, { entity_slug: "people/carol", fact: "carol lives in Rome" });
    const merged = await addFact(storage, { entity_slug: "people/carol", fact: "carol lives in Paris" });
    await engine.query("UPDATE entity_facts SET forgotten_at = now() WHERE id = $1", [gone.id]);
    await engine.query("UPDATE entity_facts SET consolidated = true WHERE id = $1", [merged.id]);

    const seen: string[] = [];
    const capture: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const r = await withProbeOn(() => probeContradictionsPhase(engine, { sonnetFn: capture }));
    expect(r.pairsScanned).toBe(1);
    expect(seen[0]).toContain("Oslo");
    expect(seen[0]).toContain("Bergen");
  });

  it("defaultPairs never pairs a rejected, inactive or superseded take", async () => {
    const insertTake = (key: string, doc: string, claim: string) =>
      engine.query(
        `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, domain, model_id)
         VALUES ($1, $2, 'h', 'v1', $3, 'markets', 'm')`,
        [key, doc, claim],
      );
    for (const id of ["d1", "d2", "d3", "d4", "d5"]) {
      await engine.query(`INSERT INTO documents (id, source_path) VALUES ($1, $2)`, [id, `/vault/${id}.md`]);
    }
    await insertTake("t-live-1", "d1", "rates will fall next year");
    await insertTake("t-live-2", "d2", "rates will rise next year");
    await insertTake("t-rejected", "d3", "rates will stay flat");
    await insertTake("t-inactive", "d4", "rates will double");
    await insertTake("t-superseded", "d5", "rates will halve");
    await engine.query(`UPDATE synth_takes SET status = 'rejected' WHERE take_key = 't-rejected'`);
    await engine.query(`UPDATE synth_takes SET active = false WHERE take_key = 't-inactive'`);
    await engine.query(`UPDATE synth_takes SET superseded_by = 1 WHERE take_key = 't-superseded'`);

    const seen: string[] = [];
    const capture: SonnetFn = async (input) => {
      seen.push(input.user);
      return { text: CONTRADICTS, modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const r = await withProbeOn(() => probeContradictionsPhase(engine, { sonnetFn: capture }));
    expect(r.pairsScanned).toBe(1);
    expect(seen[0]).toContain("rates will fall next year");
    expect(seen[0]).toContain("rates will rise next year");
  });

  it("pairKey is stable + order-sensitive", () => {
    expect(pairKey("1", "2", "v")).toBe(pairKey("1", "2", "v"));
    expect(pairKey("1", "2", "v")).not.toBe(pairKey("2", "1", "v"));
  });

  // Regression: the real defaultPairs generator must NEVER pair two tenants'
  // facts that share an entity_slug — that would leak one tenant's private fact
  // text into the other's find_contradictions read.
  it("defaultPairs never crosses a tenant boundary on a shared slug", async () => {
    const SLUG = "people/alice-smith";
    const B_MARK = "TenantB-private-marker-9931";
    await registerSource(engine, { id: "tenantA", kind: "vault", pathPrefix: "/tenant-a" });
    await registerSource(engine, { id: "tenantB", kind: "vault", pathPrefix: "/tenant-b" });
    await addFact(storage, { entity_slug: SLUG, fact: "alice lives in Gotham", source_id: "tenantA" });
    await addFact(storage, { entity_slug: SLUG, fact: "alice lives in Metropolis", source_id: "tenantA" });
    await addFact(storage, { entity_slug: SLUG, fact: `alice ${B_MARK} lives in Gotham`, source_id: "tenantB" });

    const prev = process.env.MEMRAIN_PROBE_CONTRADICTIONS;
    process.env.MEMRAIN_PROBE_CONTRADICTIONS = "1";
    try {
      // No pairsFn → exercises the real SQL defaultPairs path. Judge always says
      // "contradicts" so every generated pair would be stored.
      await probeContradictionsPhase(engine, { sonnetFn: fakeSonnet(CONTRADICTS) });
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_PROBE_CONTRADICTIONS = prev;
      else delete process.env.MEMRAIN_PROBE_CONTRADICTIONS;
    }

    // tenantB's single fact has no same-tenant partner → nothing stored for it.
    expect(await listProbedContradictions(storage, { sourceIds: ["tenantB"] })).toHaveLength(0);
    // tenantA's two facts pair within the tenant; none of its rows may carry
    // tenantB's private marker text.
    const aRows = await listProbedContradictions(storage, { sourceIds: ["tenantA"] });
    for (const row of aRows) {
      expect(JSON.stringify(row)).not.toContain(B_MARK);
    }
  });
});

describe("migration 131", () => {
  it("reverts to the pre-131 runs table, keeping its rows, and re-applies", async () => {
    await probeContradictionsPhase(engine, {
      sonnetFn: fakeSonnet(CONTRADICTS),
      pairsFn: async () => [pair("1", "2")],
    });
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 131).sort((a, b) => b - a);
    for (const id of later) await revertMigration(engine, id);
    await revertMigration(engine, 131);
    const cols = await engine.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'synth_contradiction_runs'
          AND column_name IN ('judge_errors', 'parse_failures', 'judge_failed')`,
    );
    expect(cols.rows).toEqual([]);
    const n = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_contradiction_runs`);
    expect(n.rows[0]!.n).toBe(1);

    const again = await runMigrations(engine);
    expect(again.applied.map((m) => m.id)).toEqual([131, ...later.reverse()]);
    expect(await latestContradictionRun(engine)).toMatchObject({
      judged: 1, judge_errors: 0, parse_failures: 0, judge_failed: false,
    });
  });
});
