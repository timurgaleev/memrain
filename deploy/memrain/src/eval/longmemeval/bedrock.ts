/**
 * The harness's paid boundary in production: Titan embeddings and Bedrock
 * Converse, through the same helpers (and spend chokepoint) the brain uses.
 * The output cap is passed through on every chat call.
 */
import { embedText } from "../../core/embedding.ts";
import { callSonnet } from "../../core/llm/sonnet.ts";
import type { LmeBedrock } from "./harness.ts";

export function bedrockBoundary(): LmeBedrock {
  return {
    embed: async (text, modelId) => {
      let inputTokens = 0;
      const vector = await embedText(text, { modelId, onUsage: (u) => { inputTokens = u.inputTokens; } });
      return { vector, inputTokens };
    },
    converse: async ({ modelId, system, user, maxTokens }) => {
      const r = await callSonnet({ system, user, maxTokens, temperature: 0 }, { modelId, operation: "longmemeval" });
      return { text: r.text, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    },
  };
}
