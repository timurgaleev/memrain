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

describe("verifyQuotes meaning guard", () => {
  const ev = ["The board did not approve the merger in March 2026 after the vote."];

  it("does not repair a near match that drops a negation", () => {
    const r = verifyQuotes(`It says "the board did approve the merger in March 2026"`, ev);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 1 });
    expect(r.answer).toContain(`the board did approve the merger in March 2026 [unverified]`);
  });

  it("does not repair a near match whose numbers differ", () => {
    const r = verifyQuotes(`It says "the board did not approve the merger in March 2025"`, ev);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 1 });
  });

  it("does not repair across a contracted or non-English negation", () => {
    const r1 = verifyQuotes(`"The board didn't approve the merger in March"`, ["The board did approve the merger in March."]);
    expect(r1.quote_check.repaired).toBe(0);
    const r2 = verifyQuotes(`"Совет директоров одобрил слияние в марте"`, ["Совет директоров не одобрил слияние в марте."]);
    expect(r2.quote_check.repaired).toBe(0);
    const r3 = verifyQuotes(`"Der Vorstand hat die Fusion im März genehmigt"`, ["Der Vorstand hat die Fusion im März nicht genehmigt."]);
    expect(r3.quote_check.repaired).toBe(0);
  });

  it("still repairs when negations and numbers agree", () => {
    const r = verifyQuotes(`"the board did not approve the merger in March 2026 after a vote"`, ev);
    expect(r.quote_check.repaired).toBe(1);
  });
});

describe("verifyQuotes quote shapes", () => {
  it("checks German and guillemet quote pairs", () => {
    const r = verifyQuotes(`Er sagte „wir verdoppeln das Team im nächsten Quartal“ und «nous doublerons l'équipe très bientôt».`, evidence);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 2 });
    expect(r.answer).toBe(
      `Er sagte wir verdoppeln das Team im nächsten Quartal [unverified] und nous doublerons l'équipe très bientôt [unverified].`,
    );
  });

  it("does not take an inch mark after a digit for a quote opener", () => {
    const r = verifyQuotes(`A 27" monitor, and "we will double headcount next quarter" was said.`, evidence);
    expect(r.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 1 });
    expect(r.unverified_quotes[0]!.text).toBe("we will double headcount next quarter");
  });

  it("treats bracketed ellipses as elisions on both sides", () => {
    expect(verifyQuotes(`"The team agreed [...] pending the security review."`, evidence).quote_check.grounded).toBe(1);
    expect(verifyQuotes(`"The team agreed […] pending the security review."`, evidence).quote_check.grounded).toBe(1);
    const bracketed = ["The team agreed [...] pending the security review."];
    expect(verifyQuotes(`"The team agreed … pending the security review."`, bracketed).quote_check.grounded).toBe(1);
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
