/**
 * `memrain eval` scoring: chunks of one page count once, and abstention
 * queries (no expected paths) stay out of the recall/MRR averages and are
 * reported as a false-positive rate. The searchFn seam returns canned
 * rankings; evalRun never touches the storage handle on that path.
 */
import { describe, expect, it } from "bun:test";
import { evalRun, staleQrelsReason, expectedTargets, type EvalOptions, type Qrels } from "../src/commands/eval.ts";
import type { Storage } from "../src/core/storage.ts";

type SearchFn = NonNullable<EvalOptions["searchFn"]>;
const storage = {} as Storage;

function canned(rankings: Record<string, string[]>): SearchFn {
  return async (_s, query) => rankings[query] ?? [];
}

describe("page-level scoring", () => {
  it("scores [A,A,B] against {A,C} as recall 0.5, MRR 1", async () => {
    const qrels: Qrels = { queries: [{ id: "q", query: "q", expected_paths: ["A", "C"] }] };
    const r = await evalRun(storage, qrels, {}, { k: 5, searchFn: canned({ q: ["A", "A", "B"] }) });
    expect(r.perQuery[0]!.recallAtK).toBe(0.5);
    expect(r.perQuery[0]!.mrr).toBe(1);
    expect(r.perQuery[0]!.hits).toBe(2);
    expect(r.perQuery[0]!.topPaths).toEqual(["A", "B"]);
  });

  it("ranks A at 2, not 3, behind two chunks of B", async () => {
    const qrels: Qrels = { queries: [{ id: "q", query: "q", expected_paths: ["A"] }] };
    const r = await evalRun(storage, qrels, {}, { k: 5, searchFn: canned({ q: ["B", "B", "A"] }) });
    expect(r.perQuery[0]!.mrr).toBe(0.5);
    expect(r.meanReciprocalRank).toBe(0.5);
  });
});

describe("abstention queries", () => {
  const qrels: Qrels = {
    queries: [
      { id: "hit", query: "hit", expected_paths: ["A"] },
      { id: "miss", query: "miss", expected_paths: ["A"] },
      { id: "quiet", query: "quiet", expected_paths: [] },
      { id: "noisy", query: "noisy", expected_paths: [] },
    ],
  };
  const search = canned({ hit: ["A"], miss: ["X"], quiet: [], noisy: ["Y", "Y"] });

  it("keeps them out of every average instead of scoring them 1.0", async () => {
    const r = await evalRun(storage, qrels, {}, { k: 5, searchFn: search });
    expect(r.scoredQueries).toBe(2);
    expect(r.meanRecall).toBe(0.5);
    expect(r.meanReciprocalRank).toBe(0.5);
    expect(r.hitRate).toBe(0.5);
    expect(r.perQuery.filter((q) => q.abstention).map((q) => q.id)).toEqual(["quiet", "noisy"]);
  });

  it("reports any hit on an unanswerable query as a false positive", async () => {
    const r = await evalRun(storage, qrels, {}, { k: 5, searchFn: search });
    expect(r.abstention).toEqual({ count: 2, returnedAny: 1, falsePositiveRate: 0.5 });
  });

  it("reports zero means when every query abstains, and a null rate when none does", async () => {
    const only: Qrels = { queries: [{ id: "quiet", query: "quiet", expected_paths: [] }] };
    const r = await evalRun(storage, only, {}, { k: 5, searchFn: search });
    expect(r.scoredQueries).toBe(0);
    expect(r.meanRecall).toBe(0);
    expect(r.abstention).toEqual({ count: 1, returnedAny: 0, falsePositiveRate: 0 });
    const none = await evalRun(storage, { queries: [qrels.queries[0]!] }, {}, { k: 5, searchFn: search });
    expect(none.abstention.falsePositiveRate).toBeNull();
  });
});

describe("staleQrelsReason", () => {
  const qrels: Qrels = {
    queries: [
      { id: "a", query: "a", expected_paths: ["p1", "p2"] },
      { id: "b", query: "b", expected_paths: ["p2", "p3"] },
      { id: "c", query: "c", expected_paths: [] },
    ],
  };

  it("counts each expected path once", () => {
    expect(expectedTargets(qrels)).toEqual(["p1", "p2", "p3"]);
  });

  it("refuses above half missing and accepts at or below half", () => {
    expect(staleQrelsReason(["p1", "p2", "p3"], new Set(["p1"]))).toContain("2 of 3");
    expect(staleQrelsReason(["p1", "p2"], new Set(["p1"]))).toBeNull();
    expect(staleQrelsReason([], new Set())).toBeNull();
  });
});
