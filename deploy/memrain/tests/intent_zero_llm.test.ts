/**
 * classifyIntentZeroLlm — the admin panel's search intent. It must agree with
 * classifyIntent's heuristics and taxonomy and never reach Bedrock, whatever
 * MEMRAIN_INTENT_LLM says.
 */
import { describe, expect, it } from "bun:test";
import { classifyIntent, classifyIntentZeroLlm } from "../src/core/search/intent.ts";

describe("classifyIntentZeroLlm", () => {
  it("matches the cheap heuristics", () => {
    expect(classifyIntentZeroLlm("\"x\"")).toBe("exact");
    expect(classifyIntentZeroLlm("how do I rotate a token")).toBe("howto");
    expect(classifyIntentZeroLlm("who is alice")).toBe("factual");
    expect(classifyIntentZeroLlm("   ")).toBe("topic");
  });

  it("returns what classifyIntent returns with the LLM off", async () => {
    const prev = process.env.MEMRAIN_INTENT_LLM;
    delete process.env.MEMRAIN_INTENT_LLM;
    try {
      for (const q of ["\"exact phrase\"", "how to deploy", "what is memrain", "alice smith", "last week meetings", "everything about graphs"]) {
        expect(classifyIntentZeroLlm(q)).toBe(await classifyIntent(q));
      }
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_INTENT_LLM = prev;
    }
  });

  it("is synchronous and ignores MEMRAIN_INTENT_LLM", () => {
    const prev = process.env.MEMRAIN_INTENT_LLM;
    process.env.MEMRAIN_INTENT_LLM = "1";
    try {
      const out = classifyIntentZeroLlm("an unmatched query about nothing");
      expect(typeof out).toBe("string");
      expect(["factual", "topic", "howto", "personal", "exact"]).toContain(out);
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_INTENT_LLM;
      else process.env.MEMRAIN_INTENT_LLM = prev;
    }
  });
});
