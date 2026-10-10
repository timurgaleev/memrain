/**
 * Model-free quote check for think answers: grounded quotes stay, near matches
 * are repaired to the evidence's words, quotes found nowhere lose their
 * quotation marks and gain "[unverified]".
 */
import { describe, expect, it } from "bun:test";
import {
  isQuoteInText,
  thinkQuoteVerifyEnabled,
  verifyQuotes,
} from "../src/core/synthesis/quote-verify.ts";

const evidence = [
  `<page ref="notes/plan.md" rank="1">\nThe team agreed to ship the beta in March, pending the security review.\n</page>`,
  "Pricing will stay flat through the end of the year.",
];

describe("verifyQuotes", () => {
  it("keeps a quote found in the evidence, across case, whitespace and curly quotes", () => {
    const answer = "The note says “the team agreed to ship   the beta in March” [notes/plan.md].";
    const r = verifyQuotes(answer, evidence);
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 0 });
    expect(r.answer).toBe(answer);
    expect(r.unverified_quotes).toEqual([]);
  });

  it("repairs a near-verbatim quote to the evidence's own words", () => {
    const r = verifyQuotes(`It says "Pricing will stay flat through the end of this year."`, evidence);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 1, unverified: 0 });
    expect(r.answer).toBe(`It says "Pricing will stay flat through the end of the year."`);
    expect(r.answer_raw).toBe(`It says "Pricing will stay flat through the end of this year."`);
  });

  it("unquotes and marks a quote found in no evidence", () => {
    const r = verifyQuotes(`The CEO said "we will double headcount next quarter" in May.`, evidence);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 1 });
    expect(r.answer).toBe("The CEO said we will double headcount next quarter [unverified] in May.");
    expect(r.unverified_quotes).toEqual([
      { text: "we will double headcount next quarter", reason: "quote_not_in_evidence" },
    ]);
  });

  it("grounds an elided quote whose parts appear in order", () => {
    const r = verifyQuotes(`"The team agreed ... pending the security review."`, evidence);
    expect(r.quote_check.grounded).toBe(1);
    const reversed = verifyQuotes(`"pending the security review ... the team agreed to ship"`, evidence);
    expect(reversed.quote_check.unverified).toBe(1);
  });

  it("ignores short quoted terms", () => {
    const r = verifyQuotes(`The "beta" label and the "launch plan" doc.`, evidence);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 0 });
    expect(r.answer).toBe(`The "beta" label and the "launch plan" doc.`);
  });

  it("checks every quote and applies edits without shifting the others", () => {
    const answer = `A "invented words that appear nowhere at all" then "Pricing will stay flat through the end of the year".`;
    const r = verifyQuotes(answer, evidence);
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 1 });
    expect(r.answer).toBe(
      `A invented words that appear nowhere at all [unverified] then "Pricing will stay flat through the end of the year".`,
    );
  });
});

describe("isQuoteInText", () => {
  it("matches after folding and rejects text not present", () => {
    expect(isQuoteInText("Ship the BETA in march.", evidence[0]!)).toBe(true);
    expect(isQuoteInText("ship the gamma in march", evidence[0]!)).toBe(false);
    expect(isQuoteInText("...", evidence[0]!)).toBe(false);
  });
});

describe("thinkQuoteVerifyEnabled", () => {
  it("is on unless explicitly turned off", () => {
    expect(thinkQuoteVerifyEnabled(undefined)).toBe(true);
    expect(thinkQuoteVerifyEnabled("1")).toBe(true);
    for (const off of ["0", "false", "OFF", "no"]) expect(thinkQuoteVerifyEnabled(off)).toBe(false);
  });
});
