/**
 * eval-probe per-run cost cap: --max-usd converts to an effective query limit,
 * and the tighter of (limit, budget-cap) wins.
 */
import { describe, expect, it } from "bun:test";
import {
  effectiveProbeLimit,
  probeSummary,
  PER_QUERY_USD_ESTIMATE,
} from "../src/commands/eval-probe.ts";

describe("effectiveProbeLimit", () => {
  it("returns the explicit limit when no USD cap is set", () => {
    expect(effectiveProbeLimit(50, undefined)).toBe(50);
    expect(effectiveProbeLimit(undefined, undefined)).toBeUndefined();
  });

  it("converts a USD cap to a query count", () => {
    // 0.01 / 0.001 = 10 queries.
    expect(effectiveProbeLimit(undefined, 0.01)).toBe(Math.floor(0.01 / PER_QUERY_USD_ESTIMATE));
  });

  it("takes the tighter of an explicit limit and the USD-derived cap", () => {
    expect(effectiveProbeLimit(100, 0.01)).toBe(10); // budget wins
    expect(effectiveProbeLimit(5, 0.05)).toBe(5); // explicit limit wins
  });

  it("never returns below 1 for a tiny positive budget", () => {
    expect(effectiveProbeLimit(undefined, 0.0000001)).toBe(1);
  });
});

describe("probeSummary", () => {
  it("prints the trend axes with their bootstrap intervals", () => {
    const out = probeSummary(
      {
        ok: true,
        ranAt: "2026-09-19T02:30:00.000Z",
        totalQueries: 9,
        scored: 9,
        meanRR: 0.611,
        hitRate: 0.889,
        meanRRCi95: { lo: 0.39, hi: 0.83 },
        hitRateCi95: { lo: 0.67, hi: 1 },
        replayedIdsSha256: "b".repeat(64),
        unscored: { count: 0, returnedAny: 0 },
        perQuery: [],
      },
      7,
      "capped",
    );
    expect(out).toMatchObject({
      snapshot_id: 7,
      status: "capped",
      replayed_ids_sha256: "b".repeat(64),
      mean_rr: 0.611,
      mean_rr_ci95: { lo: 0.39, hi: 0.83 },
      hit_rate: 0.889,
      hit_rate_ci95: { lo: 0.67, hi: 1 },
    });
  });
});
