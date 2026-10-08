/**
 * Conversation→facts extractor: budget tracker, response parser, and the
 * end-to-end command with a stubbed Sonnet model (no Bedrock). PGLite storage.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  BudgetTracker,
  BudgetExhausted,
  costUsd,
  priceFor,
} from "../src/core/budget.ts";
import {
  DEFAULT_EXTRACTION_MAX_TOKENS,
  extractFactsFromTurn,
  isUnknownSpeakerLabel,
  parseFactsResponse,
  slugifyEntity,
} from "../src/core/facts-extract.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import { listFacts } from "../src/core/facts.ts";
import type { SonnetFn, SonnetUsage } from "../src/core/llm/sonnet.ts";

setDefaultTimeout(25000);

describe("budget pricing", () => {
  it("prices sonnet and haiku per 1M tokens", () => {
    expect(priceFor("eu.anthropic.claude-sonnet-4-6-v1:0")).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 15.0,
    });
    expect(priceFor("eu.anthropic.claude-haiku-4-5-v1:0")).toEqual({
      inputPer1M: 1.0,
      outputPer1M: 5.0,
    });
    expect(priceFor("global.amazon.nova-2-lite-v1:0")).toBeNull();
    expect(costUsd("sonnet", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(3.0, 6);
  });

  it("prices the 5-generation ids by their own row, not the family row", () => {
    expect(priceFor("eu.anthropic.claude-haiku-5-5")).toEqual({ inputPer1M: 0.11, outputPer1M: 0.55 });
    expect(priceFor("eu.anthropic.claude-sonnet-5-5")).toEqual({ inputPer1M: 2.2, outputPer1M: 11.0 });
    expect(priceFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({ inputPer1M: 1.0, outputPer1M: 5.0 });
  });

  it("throws BudgetExhausted at the cap and on unpriced models", () => {
    const b = new BudgetTracker(0.001, "test");
    expect(() =>
      b.record("sonnet", { inputTokens: 100, outputTokens: 50 }),
    ).toThrow(BudgetExhausted); // 0.00105 > 0.001
    const b2 = new BudgetTracker(1.0, "test");
    expect(() =>
      b2.record("nova-lite", { inputTokens: 10, outputTokens: 10 }),
    ).toThrow(/no pricing/);
  });

  it("accumulates under the cap without throwing", () => {
    const b = new BudgetTracker(1.0, "test");
    b.record("sonnet", { inputTokens: 1000, outputTokens: 500 });
    expect(b.totalSpent()).toBeGreaterThan(0);
    expect(b.snapshot().callsRecorded).toBe(1);
  });
});

describe("parseFactsResponse", () => {
  it("parses a valid facts object and clamps confidence", () => {
    const { facts } = parseFactsResponse(
      '{"facts":[{"fact":"Alice loves coffee","kind":"preference","entity":"Alice","confidence":1.4,"notability":"high"}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      fact: "Alice loves coffee",
      kind: "preference",
      entity: "Alice",
      confidence: 1,
      notability: "high",
    });
  });
  it("parses typed-claim fields for a quantitative fact", () => {
    const { facts } = parseFactsResponse(
      '{"facts":[{"fact":"Acme burns 80k monthly","kind":"fact","entity":"companies/acme","confidence":0.9,"notability":"high","metric":"burn_rate","value":80000,"unit":"USD","period":"monthly"}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.claim_metric).toBe("burn_rate");
    expect(facts[0]!.claim_value).toBe(80000);
    expect(facts[0]!.claim_unit).toBe("USD");
    expect(facts[0]!.claim_period).toBe("monthly");
  });
  it("leaves claim fields undefined for a non-quantitative fact", () => {
    const { facts } = parseFactsResponse(
      '{"facts":[{"fact":"Alice loves coffee","kind":"preference","entity":"Alice","confidence":1,"notability":"low","metric":null,"value":null,"unit":null,"period":null}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.claim_metric).toBeUndefined();
    expect(facts[0]!.claim_value).toBeUndefined();
  });
  it("strips a code fence and tolerates garbage", () => {
    expect(parseFactsResponse('```json\n{"facts":[]}\n```').facts).toEqual([]);
    expect(parseFactsResponse("not json").facts).toEqual([]);
  });
  it("slugifies entity names", () => {
    expect(slugifyEntity("Alice Example")).toBe("alice-example");
    expect(slugifyEntity("Alice Smith")).toBe("alice-smith");
    expect(slugifyEntity("  !!  ")).toBeNull();
  });
  it("preserves path separators, slugifying per segment", () => {
    expect(slugifyEntity("people/bob jones")).toBe("people/bob-jones");
    expect(slugifyEntity("People/Bob Jones")).toBe("people/bob-jones");
    expect(slugifyEntity("people//bob")).toBe("people/bob");
    expect(slugifyEntity("/people/bob/")).toBe("people/bob");
    expect(slugifyEntity("///")).toBeNull();
  });
});

describe("truncated extractor output", () => {
  const GOOD = JSON.stringify({
    facts: [
      { fact: "Alice gave up coffee", kind: "commitment", entity: "Alice", confidence: 1, notability: "high" },
    ],
  });
  const CUT_OFF = '{"facts":[{"fact":"Alice gave up cof';

  /** Records every call; replies per the canned script. */
  function scriptedFn(replies: { text: string; stopReason?: string }[]) {
    const seen: { maxTokens: number }[] = [];
    const fn: SonnetFn = async (input) => {
      const r = replies[Math.min(seen.length, replies.length - 1)]!;
      seen.push({ maxTokens: input.maxTokens });
      return {
        text: r.text,
        modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
        usage: { inputTokens: 100, outputTokens: 50 },
        ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      };
    };
    return { fn, seen };
  }

  it("does not retry a complete response", async () => {
    const { fn, seen } = scriptedFn([{ text: GOOD, stopReason: "end_turn" }]);
    const result = await extractFactsFromTurn("Alice: I quit coffee", { sonnetFn: fn });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxTokens).toBe(DEFAULT_EXTRACTION_MAX_TOKENS);
    expect(result.facts).toHaveLength(1);
  });

  it("retries once at double the cap when the model hit max_tokens", async () => {
    const { fn, seen } = scriptedFn([
      { text: CUT_OFF, stopReason: "max_tokens" },
      { text: GOOD, stopReason: "end_turn" },
    ]);
    const result = await extractFactsFromTurn("Alice: I quit coffee", {
      sonnetFn: fn,
      canAffordRetry: () => true,
    });
    expect(seen.map((s) => s.maxTokens)).toEqual([
      DEFAULT_EXTRACTION_MAX_TOKENS,
      DEFAULT_EXTRACTION_MAX_TOKENS * 2,
    ]);
    // The truncated first parse yields nothing; the retry recovers the fact.
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.fact).toBe("Alice gave up coffee");
    // Both calls were paid for, so both are priced.
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it("gives up after one retry when the output is still truncated", async () => {
    const { fn, seen } = scriptedFn([{ text: CUT_OFF, stopReason: "max_tokens" }]);
    const result = await extractFactsFromTurn("Alice: I quit coffee", {
      sonnetFn: fn,
      canAffordRetry: () => true,
    });
    expect(seen).toHaveLength(2);
    expect(result.facts).toEqual([]);
  });

  it("skips the retry when the caller has no budget for a second call", async () => {
    const { fn, seen } = scriptedFn([
      { text: CUT_OFF, stopReason: "max_tokens" },
      { text: GOOD, stopReason: "end_turn" },
    ]);
    const projected: SonnetUsage[] = [];
    const result = await extractFactsFromTurn("Alice: I quit coffee", {
      sonnetFn: fn,
      canAffordRetry: (u) => {
        projected.push(u);
        return false;
      },
    });
    expect(seen).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.facts).toEqual([]);
    // The gate is asked about the TOTAL the turn would reach: the first call's
    // input replayed, plus its output plus the doubled output cap.
    expect(projected).toEqual([
      { inputTokens: 200, outputTokens: 50 + DEFAULT_EXTRACTION_MAX_TOKENS * 2 },
    ]);
  });

  it("does not consult the budget gate when nothing was truncated", async () => {
    const { fn } = scriptedFn([{ text: GOOD, stopReason: "end_turn" }]);
    let asked = 0;
    await extractFactsFromTurn("Alice: I quit coffee", {
      sonnetFn: fn,
      canAffordRetry: () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(0);
  });
});

describe("anonymous-speaker attribution gate", () => {
  it("recognizes placeholder speaker labels", () => {
    for (const label of [
      "Speaker A",
      "Speaker Z9",
      "Speaker 12",
      "SPEAKER_00",
      "Participant 2",
      "**Participant 2:**",
      "spk_0",
      "Unknown",
      "user",
      "Me",
      "?",
      "Guest",
    ]) {
      expect(isUnknownSpeakerLabel(label)).toBe(true);
    }
  });

  it("leaves real entities alone", () => {
    for (const label of [
      "acme",
      "companies/acme",
      "people/alice-example",
      "Alice",
      "Speaker Pelosi",
      "Speaker Deck",
      "Guesthouse Ventures",
      "Participant Capital",
      "",
      null,
      undefined,
    ]) {
      expect(isUnknownSpeakerLabel(label)).toBe(false);
    }
  });

  it("drops the attribution but keeps the claim for an anonymous speaker", () => {
    const { facts } = parseFactsResponse(
      '{"facts":[{"fact":"speaker is joining Acme","kind":"event","entity":"Speaker A","confidence":1,"notability":"high"}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe("speaker is joining Acme");
    expect(facts[0]!.entity).toBeNull();
  });

  it("keeps a third-person entity from an anonymous turn", () => {
    const { facts } = parseFactsResponse(
      '{"facts":[{"fact":"Acme raised $5M","kind":"fact","entity":"companies/acme","confidence":0.9,"notability":"high"}]}',
    );
    expect(facts[0]!.entity).toBe("companies/acme");
  });
});

describe("runExtractConversationFacts (stubbed model)", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "tb-facts-extract-"));
  let storage: Storage;

  // Canned model: one preference fact about the speaker, fixed usage.
  const stub: SonnetFn = async (input) => {
    const m = input.user.match(/<turn>\s*([^:]+):/);
    const speaker = (m?.[1] ?? "someone").trim();
    return {
      text: JSON.stringify({
        facts: [
          { fact: `${speaker} likes tea`, kind: "preference", entity: speaker, confidence: 0.9, notability: "medium" },
        ],
      }),
      modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };

  beforeAll(async () => {
    storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("extracts facts from each turn and writes them to entity_facts", async () => {
    const transcript = "Alice: I really enjoy a cup of tea\nBob: me too, every morning";
    const report = await runExtractConversationFacts(storage, {
      text: transcript,
      sourceSlug: "chat-log",
      maxBudgetUsd: 1.0,
      sonnetFn: stub,
    });
    expect(report.ran).toBe(true);
    expect(report.turns).toBe(2);
    expect(report.factsWritten).toBe(2);
    expect(report.budgetExhausted).toBe(false);
    expect(report.spentUsd).toBeGreaterThan(0);

    const aliceFacts = await listFacts(storage, "alice");
    expect(aliceFacts.some((f) => f.fact === "Alice likes tea")).toBe(true);
  });

  it("stops before spending when the budget is too small (strict pre-ceiling)", async () => {
    const report = await runExtractConversationFacts(storage, {
      text: "Carol: I like tea\nDave: I like tea\nEve: I like tea",
      maxBudgetUsd: 0.0005, // below the worst-case per-call cost → pre-flight stops
      sonnetFn: stub,
    });
    expect(report.ran).toBe(true);
    expect(report.budgetExhausted).toBe(true);
    // Pre-flight guard fires before the first paid call — nothing dispatched.
    expect(report.factsWritten).toBe(0);
    expect(report.spentUsd).toBe(0);
  });

  it("never lets a truncation retry spend past the run's USD cap", async () => {
    // Always truncates, and bills output in proportion to the cap it was given
    // — so an unbudgeted retry at double the cap costs double to match.
    const calls: number[] = [];
    const truncating: SonnetFn = async (input) => {
      calls.push(input.maxTokens);
      return {
        text: '{"facts":[{"fact":"Alice gave up cof',
        modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
        usage: { inputTokens: 1000, outputTokens: input.maxTokens },
        stopReason: "max_tokens",
      };
    };
    // Room for one worst-case call ($0.024), not for that call plus a retry.
    const cap = 0.03;
    const report = await runExtractConversationFacts(storage, {
      text: "Alice: I really enjoy a cup of tea",
      maxBudgetUsd: cap,
      sonnetFn: truncating,
    });
    expect(report.ran).toBe(true);
    expect(report.spentUsd).toBeLessThanOrEqual(cap);
    expect(calls).toEqual([DEFAULT_EXTRACTION_MAX_TOKENS]);
    expect(report.budgetExhausted).toBe(false);
  });

  it("retries a truncated turn when the run's cap covers both calls", async () => {
    const calls: number[] = [];
    const truncatingThenGood: SonnetFn = async (input) => {
      calls.push(input.maxTokens);
      const truncated = calls.length === 1;
      return {
        text: truncated
          ? '{"facts":[{"fact":"Grace gave up cof'
          : JSON.stringify({
              facts: [
                { fact: "Grace likes tea", kind: "preference", entity: "Grace", confidence: 0.9, notability: "medium" },
              ],
            }),
        modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
        usage: { inputTokens: 1000, outputTokens: input.maxTokens },
        ...(truncated ? { stopReason: "max_tokens" } : {}),
      };
    };
    const cap = 1.0;
    const report = await runExtractConversationFacts(storage, {
      text: "Grace: I really enjoy a cup of tea",
      maxBudgetUsd: cap,
      sonnetFn: truncatingThenGood,
    });
    expect(calls).toEqual([
      DEFAULT_EXTRACTION_MAX_TOKENS,
      DEFAULT_EXTRACTION_MAX_TOKENS * 2,
    ]);
    expect(report.factsWritten).toBe(1);
    expect(report.spentUsd).toBeLessThanOrEqual(cap);
  });

  it("is default-OFF without the env gate and no injected model", async () => {
    const report = await runExtractConversationFacts(storage, {
      text: "Frank: hi",
      maxBudgetUsd: 1.0,
    });
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/MEMRAIN_FACTS_EXTRACTION/);
  });
});

// Three defects that each silently discarded or corrupted an already-paid
// extractor call. Every case below reproduces one of them.
describe("parseFactsResponse — salvage and floors", () => {
  it("a null element does not discard its valid siblings", () => {
    // Before: reading o["fact"] off null threw a TypeError out of the parser,
    // which the caller did not guard — one bad element binned the whole call.
    const r = parseFactsResponse(
      '{"facts":[null,{"fact":"Alice ships on Fridays","kind":"fact","entity":"Alice","confidence":0.9,"notability":"high"}]}',
    );
    expect(r.status).not.toBe("malformed");
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.fact).toBe("Alice ships on Fridays");
  });

  it("recovers an object the model wrapped in prose", () => {
    // A paid answer whose only flaw is a preamble is worth reading.
    const r = parseFactsResponse(
      'Here are the facts:\n{"facts":[{"fact":"Bob prefers tea","kind":"preference","entity":"Bob","confidence":0.8,"notability":"low"}]}\nHope that helps!',
    );
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.kind).toBe("preference");
  });

  it("an unreadable kind floors to belief, never to the objective kind", () => {
    // kind:null / 42 / missing used to coerce to "fact" — the strongest kind —
    // at confidence 0.7, and a NULL kind is exempt from decay entirely. Either
    // way the mislabelled row outlives every correctly typed one.
    for (const bad of ["null", "42", '"nonsense"']) {
      const r = parseFactsResponse(
        `{"facts":[{"fact":"X happened","kind":${bad},"entity":"X","confidence":0.7,"notability":"low"}]}`,
      );
      expect(r.facts).toHaveLength(1);
      expect(r.facts[0]!.kind).toBe("belief");
    }
  });

  it("distinguishes an empty turn from unreadable output", () => {
    // Both used to return [] — indistinguishable, so the backfill treated a
    // parse miss as "nothing to say" and re-paid for it on every run.
    expect(parseFactsResponse('{"facts":[]}').status).toBe("empty");
    expect(parseFactsResponse("not json at all").status).toBe("malformed");
  });
});
