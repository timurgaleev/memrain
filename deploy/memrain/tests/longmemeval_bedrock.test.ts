/**
 * The LongMemEval production boundary. The harness reserves one worst-case
 * call per invocation, so the Bedrock client underneath must send exactly one
 * attempt: the shared clients retry up to four times on their own, and every
 * retry that reaches the model bills again outside the reservation.
 */
import { describe, expect, it } from "bun:test";
import { bedrockBoundary } from "../src/eval/longmemeval/bedrock.ts";
import type { CallSonnetOptions, SonnetCallInput, SonnetCallResult } from "../src/core/llm/sonnet.ts";
import type { EmbedOptions } from "../src/core/embedding.ts";

describe("bedrockBoundary", () => {
  it("hands every paid call a single-attempt Bedrock client", async () => {
    const attempts: Record<string, number | undefined> = {};
    const boundary = bedrockBoundary({
      embed: async (_text: string, opts: EmbedOptions = {}) => {
        attempts.embed = await opts.client?.config.maxAttempts();
        opts.onUsage?.({ inputTokens: 3 });
        return [0.1];
      },
      converse: async (_input: SonnetCallInput, opts: CallSonnetOptions = {}): Promise<SonnetCallResult> => {
        attempts.converse = await opts.client?.config.maxAttempts();
        return { text: "ok", modelId: opts.modelId ?? "", usage: { inputTokens: 5, outputTokens: 1 } };
      },
    });

    const e = await boundary.embed("hello", "amazon.titan-embed-text-v2:0");
    const c = await boundary.converse({ modelId: "eu.anthropic.claude-sonnet-5-5", system: "s", user: "u", maxTokens: 10 });

    expect(attempts).toEqual({ embed: 1, converse: 1 });
    expect(e.inputTokens).toBe(3);
    expect(c).toMatchObject({ text: "ok", inputTokens: 5, outputTokens: 1 });
  });
});
