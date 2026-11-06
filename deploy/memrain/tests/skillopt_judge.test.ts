/**
 * Rule judge and gate arithmetic: answers are parsed to a slug without any
 * unbounded pattern over model text, verdicts separate an exact pick from an
 * acceptable alternative, and the gate accepts only an improvement strictly
 * beyond epsilon.
 */
import { describe, expect, it } from "bun:test";
import { NO_SKILL, gate, judge, median3, parseAnswer } from "../src/core/skillopt/judge.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

const CATALOG = new Set(["query", "brain-ops", "enrich"]);
const CASE = { expected_skill: "query", ambiguous_with: ["brain-ops"] };

describe("parseAnswer", () => {
  it("reads the slug through quotes, backticks, punctuation, case and whitespace", () => {
    for (const a of ["query", "`query`", "query.", " Query\n", '"query"', "**query**", "query\nbecause it reads"]) {
      expect(parseAnswer(a, CATALOG)).toBe("query");
    }
  });

  it("returns null for prose that does not open with a catalog slug", () => {
    expect(parseAnswer("The best skill here is query", CATALOG)).toBeNull();
    expect(parseAnswer("", CATALOG)).toBeNull();
    expect(parseAnswer("   ", CATALOG)).toBeNull();
    expect(parseAnswer("../etc/passwd", CATALOG)).toBeNull();
  });

  it("returns a lone unknown slug, so a made-up skill counts as wrong", () => {
    expect(parseAnswer("research", CATALOG)).toBe("research");
  });

  it("recognizes the no-skill answer", () => {
    expect(parseAnswer("None.", CATALOG)).toBe(NO_SKILL);
  });
});

describe("judge", () => {
  it("scores exact, ambiguous_alt, wrong and unparsed", () => {
    expect(judge("query", CASE, CATALOG).verdict).toBe("exact");
    expect(judge("brain-ops", CASE, CATALOG).verdict).toBe("ambiguous_alt");
    expect(judge("enrich", CASE, CATALOG).verdict).toBe("wrong");
    expect(judge("research", CASE, CATALOG).verdict).toBe("wrong");
    expect(judge("I would pick something", CASE, CATALOG).verdict).toBe("unparsed");
  });

  it("scores a negative case as exact only for the no-skill answer", () => {
    const negative = { expected_skill: null, ambiguous_with: [] };
    expect(judge("none", negative, CATALOG).verdict).toBe("exact");
    expect(judge("query", negative, CATALOG).verdict).toBe("wrong");
    expect(judge("none", CASE, CATALOG).verdict).toBe("wrong");
  });
});

describe("median3 and gate", () => {
  it("takes the median of odd and even counts", () => {
    expect(median3([0.2, 0.9, 0.5])).toBe(0.5);
    expect(median3([0.2, 0.4, 0.6, 0.9])).toBeCloseTo(0.5, 10);
    expect(median3([0.7])).toBe(0.7);
    expect(median3([])).toBe(0);
  });

  it("accepts iff the candidate median beats the baseline median by more than epsilon", () => {
    expect(gate([0.5, 0.5, 0.5], [1, 1, 0.5], 0.05)).toEqual({
      accept: true,
      delta: 0.5,
      baselineMedian: 0.5,
      candidateMedian: 1,
    });
    expect(gate([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.05).accept).toBe(false);
    expect(gate([1, 1, 1], [0, 0, 0], 0.05).accept).toBe(false);
    // Exactly epsilon, with the float residue 0.55 - 0.5 carries, is not an improvement.
    expect(gate([0.5], [0.55], 0.05).accept).toBe(false);
    expect(gate([0.5], [0.56], 0.05).accept).toBe(true);
  });
});

describe("parser linearity", () => {
  function parse(answer: string): void {
    for (let i = 0; i < 20; i++) parseAnswer(answer, CATALOG);
  }

  it("stays linear on large adversarial answers", () => {
    for (const unit of ["a-", "`", "x", " a"]) {
      const small = unit.repeat(25_000);
      const large = unit.repeat(50_000);
      expect(linearityRatio(() => parse(small), () => parse(large))).toBeLessThanOrEqual(3);
    }
  });
});
