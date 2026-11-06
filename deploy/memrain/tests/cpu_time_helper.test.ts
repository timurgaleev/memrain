/**
 * The CPU-time linearity ratio separates a linear workload from a quadratic
 * one on a doubling of the input, so linearity tests can assert growth
 * without reading the wall clock.
 */
import { describe, expect, it } from "bun:test";
import { linearityRatio } from "./helpers/cpu-time.ts";

function linear(n: number) {
  return () => {
    let s = 0;
    for (let i = 0; i < n; i++) s += i;
    return s;
  };
}

function quadratic(n: number) {
  return () => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) s += j;
    }
    return s;
  };
}

describe("linearityRatio", () => {
  it("is near 2 for a linear function on a doubling", () => {
    expect(linearityRatio(linear(20_000_000), linear(40_000_000))).toBeLessThanOrEqual(3);
  });

  it("is near 4 for a quadratic function on a doubling", () => {
    expect(linearityRatio(quadratic(3_000), quadratic(6_000))).toBeGreaterThan(3);
  });
});
