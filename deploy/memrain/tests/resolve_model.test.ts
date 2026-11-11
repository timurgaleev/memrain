/**
 * Unified model-tier resolver: tier defaults, deep-tier opt-in fallback,
 * and override > env > default precedence. Also exercises the circular
 * import between resolve-model.ts and haiku.ts/sonnet.ts (call-time safe).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { resolveModel } from "../src/core/llm/resolve-model.ts";
import { DEFAULT_HAIKU_MODEL } from "../src/core/llm/haiku.ts";
import { DEFAULT_SONNET_MODEL } from "../src/core/llm/sonnet.ts";

afterEach(() => {
  delete process.env.MEMRAIN_DEEP_MODEL;
  delete process.env.MEMRAIN_FACTS_MODEL;
  delete process.env.MEMRAIN_UTILITY_MODEL;
});

describe("resolveModel", () => {
  it("resolves tier built-in defaults", () => {
    expect(resolveModel("utility")).toBe(DEFAULT_HAIKU_MODEL);
    expect(resolveModel("reasoning")).toBe(DEFAULT_SONNET_MODEL);
  });

  it("deep tier falls back to reasoning (Sonnet) when unset", () => {
    expect(resolveModel("deep")).toBe(DEFAULT_SONNET_MODEL);
  });

  it("deep tier follows MEMRAIN_FACTS_MODEL when MEMRAIN_DEEP_MODEL is unset", () => {
    process.env.MEMRAIN_FACTS_MODEL = "eu.anthropic.claude-sonnet-4-6";
    expect(resolveModel("deep")).toBe("eu.anthropic.claude-sonnet-4-6");
  });

  it("deep tier uses MEMRAIN_DEEP_MODEL when set", () => {
    process.env.MEMRAIN_DEEP_MODEL = "eu.anthropic.claude-opus-x";
    expect(resolveModel("deep")).toBe("eu.anthropic.claude-opus-x");
  });

  it("override > env > default per tier; empty env falls through", () => {
    process.env.MEMRAIN_FACTS_MODEL = "env-sonnet";
    expect(resolveModel("reasoning", "override-sonnet")).toBe("override-sonnet");
    expect(resolveModel("reasoning")).toBe("env-sonnet");
    process.env.MEMRAIN_FACTS_MODEL = "";
    expect(resolveModel("reasoning")).toBe(DEFAULT_SONNET_MODEL);
  });
});
