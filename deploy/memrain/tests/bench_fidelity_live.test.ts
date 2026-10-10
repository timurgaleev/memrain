/**
 * The fidelity bench's live lane — the shipped corpus replayed against an
 * extraction model instead of the gold stub, under a hard USD cap.
 *
 * No paid call here: the "live" model is an injected fake. What is pinned is
 * the lane's contract — the cap holds across the whole run, a fixture the cap
 * cuts short leaves the scores instead of dragging them down, the rates carry
 * Wilson intervals, and a reworded claim still counts as preserved.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { loadFidelityCorpus, type FidelityFixture } from "../src/core/bench/fidelity-fixtures.ts";
import {
  DEFAULT_LIVE_FIDELITY_CAP_USD,
  claimsMatch,
  formatFidelityLive,
  makeGoldStub,
  runFidelityCorpus,
  runFidelityCorpusLive,
} from "../src/core/bench/fidelity-harness.ts";
import { DEFAULT_SONNET_MODEL, type SonnetFn, type SonnetUsage } from "../src/core/llm/sonnet.ts";
import { costUsd } from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;
let fixtures: FidelityFixture[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-fidelity-live-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  fixtures = loadFidelityCorpus();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for the real model: answers every fixture's turns with that
 * fixture's gold response, billed at `usage` on the Sonnet price.
 */
function goldModel(usage: SonnetUsage): { fn: SonnetFn; calls: () => number } {
  const stubs = fixtures.map(makeGoldStub);
  let calls = 0;
  const fn: SonnetFn = async (input) => {
    calls += 1;
    for (const stub of stubs) {
      const missesBefore = stub.unmatched.length;
      const r = await stub.fn(input);
      if (stub.unmatched.length === missesBefore) return { ...r, modelId: DEFAULT_SONNET_MODEL, usage };
    }
    return { text: '{"facts":[]}', modelId: DEFAULT_SONNET_MODEL, usage };
  };
  return { fn, calls: () => calls };
}

describe("claimsMatch", () => {
  it("is exact for the stub arm and tolerant of rewording for the live lane", () => {
    const gold = "Alice moved to Berlin in March 2024";
    const reworded = "In March 2024 Alice moved to Berlin.";
    expect(claimsMatch(gold, reworded, "exact")).toBe(false);
    expect(claimsMatch(gold, reworded, "loose")).toBe(true);
    expect(claimsMatch(gold, "Bob prefers tea", "loose")).toBe(false);
    expect(claimsMatch(gold, `${gold}.`, "exact")).toBe(true);
  });
});

describe("runFidelityCorpusLive", () => {
  it("grades the corpus with Wilson intervals, no worse than the stub arm on gold answers", async () => {
    const model = goldModel({ inputTokens: 0, outputTokens: 0 });
    const live = await runFidelityCorpusLive(storage, fixtures, { sonnetFn: model.fn });
    const stub = await runFidelityCorpus(storage, fixtures);

    expect(live.capUsd).toBe(DEFAULT_LIVE_FIDELITY_CAP_USD);
    expect(live.fixturesSkipped).toEqual([]);
    expect(live.scores.goldTotal).toBe(stub.scores.goldTotal);
    expect(live.scores.fidelityRecall!).toBeGreaterThanOrEqual(stub.scores.fidelityRecall!);
    const ci = live.recallCI!;
    expect(ci.lower).toBeLessThanOrEqual(live.scores.fidelityRecall!);
    expect(ci.upper).toBeGreaterThanOrEqual(live.scores.fidelityRecall!);
    expect(live.precisionCI).not.toBeNull();
    expect(formatFidelityLive(live)).toContain("mode: live");
  });

  it("never spends past the cap, and leaves cut-short fixtures out of the scores", async () => {
    const usage = { inputTokens: 3000, outputTokens: 1500 };
    const perCall = costUsd(DEFAULT_SONNET_MODEL, usage);
    const cap = perCall * 3.5;
    const model = goldModel(usage);
    const live = await runFidelityCorpusLive(storage, fixtures, { sonnetFn: model.fn, maxUsd: cap });

    expect(live.spentUsd).toBeLessThanOrEqual(cap + 1e-9);
    expect(model.calls() * perCall).toBeLessThanOrEqual(cap + 1e-9);
    expect(live.fixturesSkipped.length).toBeGreaterThan(0);
    const scoredNames = new Set(fixtures.map((f) => f.name).filter((n) => !live.fixturesSkipped.includes(n)));
    expect(live.runs.map((r) => r.fixture).every((n) => scoredNames.has(n))).toBe(true);
    expect(formatFidelityLive(live)).toContain("skipped by the cap");
  });

  it("refuses an unpriced model and a non-positive cap before any call", async () => {
    const model = goldModel({ inputTokens: 0, outputTokens: 0 });
    await expect(
      runFidelityCorpusLive(storage, fixtures, { sonnetFn: model.fn, modelId: "eu.example.unpriced" }),
    ).rejects.toThrow(/no price/);
    await expect(
      runFidelityCorpusLive(storage, fixtures, { sonnetFn: model.fn, maxUsd: 0 }),
    ).rejects.toThrow(/must be positive/);
    expect(model.calls()).toBe(0);
  });
});
