/**
 * The junk gate: assistant narration, conversation meta-narration and
 * provider error sentences never become facts. Narrow on purpose.
 */
import { describe, expect, it } from "bun:test";
import {
  extractFactsFromTurn,
  factsJunkFilterEnabled,
  isJunkFact,
  JUNK_FACT_PATTERNS,
  parseFactsResponse,
} from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

function answer(facts: { fact: string; kind?: string }[]): string {
  return JSON.stringify({ facts: facts.map((f) => ({ entity: "people/alice", kind: "fact", ...f })) });
}

describe("isJunkFact", () => {
  it("has exactly three patterns — widening it is a decision, not a drift", () => {
    expect(JUNK_FACT_PATTERNS).toHaveLength(3);
  });

  it.each([
    "Let me read the file first.",
    "Now let me check the tests.",
    "I'll run the migration next.",
    "I'm going to refactor this module.",
    "The user is asking about the deploy.",
    "The user wants me to fix the bug.",
    "Another agent is rewriting src/core.",
    "You've hit your org's monthly spend limit.",
    "Error: rate limit exceeded",
    "429 rate limit reached",
  ])("drops %p", (text) => {
    expect(isJunkFact(text, "fact")).toBe(true);
  });

  it.each([
    "Alice wants a monthly spend limit of $200.",
    "Bob's API rate limit is 1000 rpm.",
    "Alice lets the team pick the venue.",
    "The user interface moved to React.",
    "Alice will move to Lisbon in March.",
  ])("keeps %p", (text) => {
    expect(isJunkFact(text, "fact")).toBe(false);
  });

  it("lets a commitment through the plan-narration pattern only", () => {
    expect(isJunkFact("I'll ship the release on Friday.", "commitment")).toBe(false);
    expect(isJunkFact("I'll ship the release on Friday.", "event")).toBe(true);
    expect(isJunkFact("The user wants me to ship it.", "commitment")).toBe(true);
  });
});

describe("parseFactsResponse with the gate", () => {
  it("drops junk, keeps its siblings and counts what it dropped", () => {
    const r = parseFactsResponse(
      answer([{ fact: "Let me read the file first." }, { fact: "Alice prefers tea." }]),
    );
    expect(r.facts.map((f) => f.fact)).toEqual(["Alice prefers tea."]);
    expect(r.status).toBe("ok");
    expect(r.junk_skipped).toBe(1);
  });

  it("an answer that was only junk is an empty turn, not a broken one", () => {
    const r = parseFactsResponse(answer([{ fact: "Let me read the file first." }]));
    expect(r).toMatchObject({ facts: [], status: "empty", junk_skipped: 1 });
  });

  it("is switched off by MEMRAIN_FACTS_JUNK_FILTER=0", () => {
    expect(factsJunkFilterEnabled(undefined)).toBe(true);
    expect(factsJunkFilterEnabled("0")).toBe(false);
    expect(factsJunkFilterEnabled("off")).toBe(false);
    const r = parseFactsResponse(answer([{ fact: "Let me read the file first." }]), { junkFilter: false });
    expect(r.facts).toHaveLength(1);
    expect(r.junk_skipped).toBe(0);
  });

  it("reports the count on the turn result", async () => {
    const fn: SonnetFn = async () => ({
      text: answer([{ fact: "Let me read the file first." }, { fact: "Alice prefers tea." }]),
      modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const r = await extractFactsFromTurn("Claude: Let me read the file first.", { sonnetFn: fn });
    expect(r.junkSkipped).toBe(1);
    expect(r.facts).toHaveLength(1);
  });
});
