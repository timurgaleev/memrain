/**
 * IR-metric pure-function tests — no DB, no Bedrock, deterministic fixtures.
 */
import { describe, it, expect } from "bun:test";
import {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  meanReciprocalRank,
  ndcgAtK,
  jaccardAtK,
  top1Stable,
  binaryGrades,
} from "../src/core/search/metrics.ts";

const rel = (...ids: string[]) => new Set(ids);

describe("precisionAtK", () => {
  it("counts relevant hits in top-k over k", () => {
    expect(precisionAtK(["a", "b", "c", "d"], rel("a", "c"), 4)).toBe(0.5);
    expect(precisionAtK(["a", "b"], rel("a"), 2)).toBe(0.5);
  });
  it("uses k (not hits length) as denominator", () => {
    expect(precisionAtK(["a"], rel("a"), 4)).toBe(0.25); // 1 relevant / k=4
  });
  it("is 0 for k<=0 or no hits", () => {
    expect(precisionAtK(["a"], rel("a"), 0)).toBe(0);
    expect(precisionAtK([], rel("a"), 4)).toBe(0);
  });
});

describe("recallAtK", () => {
  it("counts relevant found in top-k over total relevant", () => {
    expect(recallAtK(["a", "b", "c"], rel("a", "x"), 3)).toBe(0.5); // found a of {a,x}
    expect(recallAtK(["a", "b"], rel("a", "b"), 2)).toBe(1);
  });
  it("respects the k cutoff", () => {
    expect(recallAtK(["x", "y", "a"], rel("a"), 2)).toBe(0); // a is at rank 3
    expect(recallAtK(["x", "y", "a"], rel("a"), 3)).toBe(1);
  });
  it("is 0 when there are no relevant docs", () => {
    expect(recallAtK(["a"], rel(), 5)).toBe(0);
  });
});

describe("reciprocalRank / MRR", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["x", "a", "b"], rel("a", "b"))).toBeCloseTo(0.5, 9);
    expect(reciprocalRank(["a"], rel("a"))).toBe(1);
  });
  it("is 0 when no relevant hit is present", () => {
    expect(reciprocalRank(["x", "y"], rel("a"))).toBe(0);
  });
  it("averages per-query reciprocal ranks", () => {
    const m = meanReciprocalRank([
      { hits: ["a"], relevant: rel("a") }, // 1
      { hits: ["x", "a"], relevant: rel("a") }, // 0.5
    ]);
    expect(m).toBeCloseTo(0.75, 9);
    expect(meanReciprocalRank([])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1.0 when the ideal doc is at rank 1 (binary)", () => {
    expect(ndcgAtK(["a", "b"], binaryGrades(["a"]), 2)).toBe(1);
  });
  it("penalises a relevant doc placed lower", () => {
    // hits [x, a], relevant a → DCG = 1/log2(3); IDCG = 1/log2(2)=1
    const v = ndcgAtK(["x", "a"], binaryGrades(["a"]), 2);
    expect(v).toBeCloseTo(1 / Math.log2(3), 9);
    expect(v).toBeLessThan(1);
  });
  it("honours graded gains and the ideal ordering", () => {
    const grades = new Map([
      ["a", 3],
      ["b", 1],
    ]);
    // perfect order a,b → nDCG 1
    expect(ndcgAtK(["a", "b"], grades, 2)).toBeCloseTo(1, 9);
    // swapped b,a → < 1
    expect(ndcgAtK(["b", "a"], grades, 2)).toBeLessThan(1);
  });
  it("is 0 when nothing relevant (IDCG=0) or k<=0", () => {
    expect(ndcgAtK(["x"], binaryGrades([]), 5)).toBe(0);
    expect(ndcgAtK(["a"], binaryGrades(["a"]), 0)).toBe(0);
  });
});

describe("jaccardAtK", () => {
  it("is overlap/union of the two top-k sets", () => {
    expect(jaccardAtK(["a", "b", "c"], ["a", "b", "x"], 3)).toBeCloseTo(2 / 4, 9);
    expect(jaccardAtK(["a", "b"], ["a", "b"], 2)).toBe(1);
  });
  it("is 1 for two empty top-k (vacuous stability), 0 for disjoint", () => {
    expect(jaccardAtK([], [], 3)).toBe(1);
    expect(jaccardAtK(["a"], ["b"], 1)).toBe(0);
  });
  it("ignores order within the top-k", () => {
    expect(jaccardAtK(["a", "b"], ["b", "a"], 2)).toBe(1);
  });
});

describe("duplicate ids do not inflate scores", () => {
  it("recall never exceeds 1.0 with a repeated relevant id", () => {
    expect(recallAtK(["a", "a"], rel("a"), 2)).toBe(1); // not 2
  });
  it("precision counts a repeated relevant id once", () => {
    // distinct top-2 of [a,a,b] is [a,b]; one relevant (a) over k=2 → 0.5
    expect(precisionAtK(["a", "a", "b"], rel("a"), 2)).toBe(0.5);
  });
  it("nDCG does not double-count a repeated relevant id", () => {
    expect(ndcgAtK(["a", "a"], binaryGrades(["a"]), 2)).toBe(1); // a at rank 1, dup ignored
  });
  it("reciprocal rank counts distinct ids, so a repeated miss does not push the hit down", () => {
    expect(reciprocalRank(["b", "b", "a"], rel("a"))).toBe(0.5); // not 1/3
  });
  it("two chunks of one relevant page are one hit for recall and rank", () => {
    expect(recallAtK(["a", "a", "b"], rel("a", "c"), 3)).toBe(0.5);
    expect(reciprocalRank(["a", "a", "b"], rel("a", "c"))).toBe(1);
  });
});

describe("top1Stable", () => {
  it("compares only the rank-1 result", () => {
    expect(top1Stable(["a", "b"], ["a", "z"])).toBe(true);
    expect(top1Stable(["a"], ["b"])).toBe(false);
    expect(top1Stable([], [])).toBe(true);
    expect(top1Stable(["a"], [])).toBe(false);
  });
});
