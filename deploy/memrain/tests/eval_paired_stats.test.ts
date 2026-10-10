/**
 * Paired A/B statistics for `memrain eval --config-b`: cluster sign-flip
 * p-values, cluster-bootstrap intervals and the Holm adjustment. Pure; no DB.
 */
import { describe, expect, it } from "bun:test";
import {
  pairedClusterStatistics,
  holmAdjusted,
  EXACT_SIGN_FLIP_MAX_CLUSTERS,
} from "../src/core/search/bootstrap.ts";

describe("pairedClusterStatistics", () => {
  it("enumerates every sign assignment for a small set: 4 equal wins give p = 2/16", () => {
    const s = pairedClusterStatistics([0, 0, 0, 0], [1, 1, 1, 1], ["a", "b", "c", "d"]);
    expect(s.exact).toBe(true);
    // Only all-plus and all-minus reach |sum| = 4.
    expect(s.p_value).toBe(0.125);
    expect(s.delta).toBe(1);
    expect([s.wins, s.losses, s.ties]).toEqual([4, 0, 0]);
    expect(s.lower95).toBe(1);
    expect(s.upper95).toBe(1);
  });

  it("treats queries of one cluster as one unit", () => {
    // Four wins in one cluster are one observation: the flip can only negate it.
    const s = pairedClusterStatistics([0, 0, 0, 0], [1, 1, 1, 1], ["x", "x", "x", "x"]);
    expect(s.clusters).toBe(1);
    expect(s.p_value).toBe(1);
    expect(s.n).toBe(4);
  });

  it("gives p = 1 and a zero interval when nothing changed", () => {
    const s = pairedClusterStatistics([0.5, 1, 0], [0.5, 1, 0], ["a", "b", "c"]);
    expect(s.p_value).toBe(1);
    expect([s.delta, s.lower95, s.upper95]).toEqual([0, 0, 0]);
    expect(s.ties).toBe(3);
  });

  it("counts wins, losses and ties per query and keeps delta inside its interval", () => {
    const a = [1, 0.5, 0, 0.25, 1, 0];
    const b = [1, 1, 0.5, 0, 1, 1];
    const s = pairedClusterStatistics(a, b, a.map((_, i) => `q${i}`));
    expect([s.wins, s.losses, s.ties]).toEqual([3, 1, 2]);
    expect(s.delta).toBeCloseTo((0 + 0.5 + 0.5 - 0.25 + 0 + 1) / 6, 4);
    expect(s.lower95).toBeLessThanOrEqual(s.delta);
    expect(s.upper95).toBeGreaterThanOrEqual(s.delta);
    expect(s.p_value).toBeGreaterThan(0);
    expect(s.p_value).toBeLessThanOrEqual(1);
  });

  it("samples sign flips above the exact limit, deterministically and never at 0", () => {
    const n = EXACT_SIGN_FLIP_MAX_CLUSTERS + 4;
    const a = Array.from<number>({ length: n }).fill(0);
    const b = Array.from<number>({ length: n }).fill(1);
    const ids = a.map((_, i) => `q${i}`);
    const s1 = pairedClusterStatistics(a, b, ids);
    const s2 = pairedClusterStatistics(a, b, ids);
    expect(s1.exact).toBe(false);
    expect(s1).toEqual(s2);
    expect(s1.p_value).toBeGreaterThan(0);
    expect(s1.p_value).toBeLessThan(0.001);
  });

  it("refuses arrays of different lengths", () => {
    expect(() => pairedClusterStatistics([1], [1, 2], ["a"])).toThrow(/length mismatch/);
  });
});

describe("holmAdjusted", () => {
  it("multiplies by the remaining family size and keeps the order monotone", () => {
    // Sorted: 0.01×3 = 0.03, 0.03×2 = 0.06, then 0.04×1 would drop to 0.04 → held at 0.06.
    expect(holmAdjusted([0.04, 0.01, 0.03]).map((p) => Math.round(p * 1e6) / 1e6)).toEqual([
      0.06, 0.03, 0.06,
    ]);
  });

  it("caps at 1 and handles an empty family", () => {
    expect(holmAdjusted([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjusted([])).toEqual([]);
  });
});
