/**
 * Paid call sites hold their estimate before awaiting the model, so callers
 * sharing one BudgetTracker cannot all pass the same headroom.
 *
 * Locks: N parallel fact classifications against a cap admit exactly
 * floor(cap / cost); a failed call gives its hold back; a truncation retry
 * widens the first call's hold instead of counting it twice; PAT names in the
 * generated-id namespaces are refused.
 */
import { describe, expect, it } from "bun:test";
import { BudgetTracker, costUsd, patNameSpendConflict } from "../src/core/budget.ts";
import { classifyFact } from "../src/core/facts-classify.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
// The classifier's per-call worst case; replies report exactly this, so a
// settle books what the hold set aside.
const CLASSIFY_USAGE = { inputTokens: 1200, outputTokens: 200 };
const CANDIDATE = { id: 1, fact: "Alice leads the platform team", kind: null, cos: 0.5 };

function slowClassifier() {
  let calls = 0;
  const llmFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { text: `{"decision":"independent"}`, modelId: HAIKU, usage: CLASSIFY_USAGE };
  };
  return { llmFn, calls: () => calls };
}

describe("parallel fact classifications on one tracker", () => {
  const cost = costUsd(HAIKU, CLASSIFY_USAGE);

  for (const admitted of [0, 1, 3, 7]) {
    it(`admit exactly floor(cap / cost) = ${admitted} of 20`, async () => {
      const cap = cost * (admitted + 0.5);
      const budget = new BudgetTracker(cap, "test");
      const { llmFn, calls } = slowClassifier();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          classifyFact({ fact: `fact ${i}`, kind: null }, [CANDIDATE], { llmFn, budget, modelId: HAIKU }),
        ),
      );
      expect(calls()).toBe(Math.floor(cap / cost));
      expect(budget.totalSpent()).toBeLessThanOrEqual(cap);
    });
  }

  it("gives a failed call's hold back", async () => {
    const budget = new BudgetTracker(cost * 1.5, "test");
    const r = await classifyFact({ fact: "f", kind: null }, [CANDIDATE], {
      llmFn: async () => {
        throw new Error("down");
      },
      budget,
      modelId: HAIKU,
    });
    expect(r.reason).toBe("cosine_fallback");
    expect(budget.reserve(HAIKU, CLASSIFY_USAGE)).not.toBeNull();
  });
});

describe("widen", () => {
  const ONE = { inputTokens: 1000, outputTokens: 0 };
  const TWO = { inputTokens: 2000, outputTokens: 0 };
  const unit = costUsd(HAIKU, ONE);

  it("does not count the hold against itself", () => {
    const budget = new BudgetTracker(unit * 2.5, "t");
    const h = budget.reserve(HAIKU, ONE)!;
    expect(budget.widen(h, HAIKU, TWO)).toBe(true);
    // Two units held now: a third no longer fits beside it.
    expect(budget.reserve(HAIKU, ONE)).toBeNull();
  });

  it("refuses without touching the hold when the larger amount does not fit", () => {
    const budget = new BudgetTracker(unit * 2.5, "t");
    const other = budget.reserve(HAIKU, ONE)!;
    const h = budget.reserve(HAIKU, ONE)!;
    expect(budget.widen(h, HAIKU, TWO)).toBe(false);
    expect(h.usd).toBeCloseTo(unit, 12);
    budget.release(other);
    budget.release(h);
    expect(budget.reserve(HAIKU, { inputTokens: 2400, outputTokens: 0 })).not.toBeNull();
  });

  it("is freed in full at settle", () => {
    const budget = new BudgetTracker(unit * 3.5, "t");
    const h = budget.reserve(HAIKU, ONE)!;
    budget.widen(h, HAIKU, { inputTokens: 3000, outputTokens: 0 });
    budget.settle(h, HAIKU, ONE);
    expect(budget.totalSpent()).toBeCloseTo(unit, 12);
    expect(budget.reserve(HAIKU, TWO)).not.toBeNull();
  });

  it("refuses a settled hold and an unpriced model", () => {
    const budget = new BudgetTracker(1, "t");
    const h = budget.reserve(HAIKU, ONE)!;
    expect(budget.widen(h, "no-such-model", TWO)).toBe(false);
    budget.release(h);
    expect(budget.widen(h, HAIKU, TWO)).toBe(false);
  });
});

describe("patNameSpendConflict", () => {
  it("refuses the client-id and enrollment-id prefixes", () => {
    expect(patNameSpendConflict("memex_cl_abc")).toContain("memex_cl_");
    expect(patNameSpendConflict("memex_enr_abc")).toContain("memex_enr_");
  });

  it("refuses the chat owners' spend-id prefix", () => {
    expect(patNameSpendConflict("memrain_chat_operator")).toContain("memrain_chat_");
  });

  it("allows ordinary names", () => {
    expect(patNameSpendConflict("timur-laptop")).toBeNull();
    expect(patNameSpendConflict("memex_client")).toBeNull();
  });
});
