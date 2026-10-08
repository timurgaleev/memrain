/**
 * LLM gateway: per-process inflight concurrency cap + availability probe.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { generationFields, isLlmAvailable, responseText, withInflightCap } from "../src/core/llm/gateway.ts";

afterEach(() => delete process.env.MEMRAIN_LLM_MAX_INFLIGHT);

describe("withInflightCap", () => {
  it("caps peak concurrency at MEMRAIN_LLM_MAX_INFLIGHT", async () => {
    process.env.MEMRAIN_LLM_MAX_INFLIGHT = "4";
    let peak = 0;
    let active = 0;
    const fake = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 12 }, () => withInflightCap(fake)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });

  it("runs all queued work to completion", async () => {
    process.env.MEMRAIN_LLM_MAX_INFLIGHT = "2";
    let done = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withInflightCap(async () => {
          await new Promise((r) => setTimeout(r, 1));
          done++;
        }),
      ),
    );
    expect(done).toBe(6);
  });
});

describe("isLlmAvailable", () => {
  it("is true when a region/profile/key is present", () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    expect(isLlmAvailable()).toBe(true);
    if (prev === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prev;
  });
});

describe("generationFields", () => {
  it("keeps the caller's temperature on pre-5 models", () => {
    expect(generationFields("eu.anthropic.claude-haiku-4-5-20251001-v1:0", 64, 0.3)).toEqual({
      inferenceConfig: { maxTokens: 64, temperature: 0.3 },
    });
  });

  it("drops temperature and turns thinking off on Haiku 5.5", () => {
    expect(generationFields("eu.anthropic.claude-haiku-5-5", 64, 0)).toEqual({
      inferenceConfig: { maxTokens: 64 },
      additionalModelRequestFields: { thinking: { type: "disabled" } },
    });
  });

  it("uses between_tools on Sonnet 5.5, which rejects disabled", () => {
    expect(generationFields("eu.anthropic.claude-sonnet-5-5", 64, 0).additionalModelRequestFields).toEqual({
      thinking: { type: "between_tools" },
    });
  });

  it("leaves thinking at the model default where it cannot be turned off", () => {
    expect(generationFields("eu.anthropic.claude-opus-5-5", 64, 0)).toEqual({ inferenceConfig: { maxTokens: 64 } });
  });
});

describe("responseText", () => {
  it("skips a leading reasoning block", () => {
    expect(responseText([{}, { text: "answer" }])).toBe("answer");
  });

  it("is undefined when there is no text block", () => {
    expect(responseText(undefined)).toBeUndefined();
    expect(responseText([{}])).toBeUndefined();
  });
});
