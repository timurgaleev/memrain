/**
 * `MEMRAIN_FACTS_EXTRACT_MODEL` — fact extraction's own model key.
 *
 * Unset, nothing moves: extraction stays on the reasoning tier. Set, it moves
 * extraction alone, and it has to reach the model the budget prices, not only
 * the transport — the extractor resolves its model id up front and hands it
 * down, so a key read only at the call would be overridden every time.
 * No paid calls: the model is an injected stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveFactsModel, DEFAULT_SONNET_MODEL, type SonnetFn } from "../src/core/llm/sonnet.ts";
import { DEFAULT_HAIKU_MODEL } from "../src/core/llm/haiku.ts";
import { extractFactsOnDemand } from "../src/core/facts-extract.ts";

const KEYS = ["MEMRAIN_FACTS_EXTRACT_MODEL", "MEMRAIN_FACTS_MODEL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function countingSonnet() {
  let calls = 0;
  const fn: SonnetFn = async () => {
    calls += 1;
    return { text: '{"facts":[]}', modelId: "stub", usage: { inputTokens: 10, outputTokens: 10 } };
  };
  return { fn, calls: () => calls };
}

describe("resolveFactsModel with the facts_extract feature", () => {
  it("leaves the default where it was when the key is unset", () => {
    expect(resolveFactsModel(undefined, "facts_extract")).toBe(DEFAULT_SONNET_MODEL);
    expect(resolveFactsModel()).toBe(DEFAULT_SONNET_MODEL);
  });

  it("moves extraction alone, and an explicit id still wins", () => {
    process.env["MEMRAIN_FACTS_EXTRACT_MODEL"] = DEFAULT_HAIKU_MODEL;
    expect(resolveFactsModel(undefined, "facts_extract")).toBe(DEFAULT_HAIKU_MODEL);
    expect(resolveFactsModel()).toBe(DEFAULT_SONNET_MODEL);
    expect(resolveFactsModel("explicit-id", "facts_extract")).toBe("explicit-id");
  });

  it("treats an empty key as unset (a compose passthrough default)", () => {
    process.env["MEMRAIN_FACTS_EXTRACT_MODEL"] = "";
    process.env["MEMRAIN_FACTS_MODEL"] = DEFAULT_HAIKU_MODEL;
    expect(resolveFactsModel(undefined, "facts_extract")).toBe(DEFAULT_HAIKU_MODEL);
  });
});

describe("the extractor prices the model the key names", () => {
  it("an unpriced extraction model is refused before the call", async () => {
    // The budget refuses an unpriced model, so a refusal here proves the key
    // reached the id the extractor reserved against.
    process.env["MEMRAIN_FACTS_EXTRACT_MODEL"] = "eu.example.unpriced-model";
    const sonnet = countingSonnet();
    const r = await extractFactsOnDemand("Alice joined Acme as CTO in 2024.", { sonnetFn: sonnet.fn });
    expect(r.skipped).toBe("budget_exhausted");
    expect(sonnet.calls()).toBe(0);
  });

  it("runs on the default when the key is unset", async () => {
    const sonnet = countingSonnet();
    const r = await extractFactsOnDemand("Alice joined Acme as CTO in 2024.", { sonnetFn: sonnet.fn });
    expect(r.skipped).toBeUndefined();
    expect(sonnet.calls()).toBe(1);
  });
});
