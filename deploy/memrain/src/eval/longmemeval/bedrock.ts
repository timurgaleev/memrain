/**
 * The harness's paid boundary in production: Titan embeddings and Bedrock
 * Converse, through the same helpers (and spend chokepoint) the brain uses.
 * The output cap is passed through on every chat call.
 *
 * The ledger reserves one worst-case call per invocation, so each invocation
 * must reach the model at most once. The brain's shared clients retry up to
 * four times on their own, and a retried request can bill again; these
 * clients send a single attempt, and a failure surfaces to the harness, which
 * charges the reservation in full and stops.
 */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { embedText } from "../../core/embedding.ts";
import { awsRegion, bedrockClientConfig, embedTimeoutMs, reasoningTimeoutMs } from "../../core/llm/gateway.ts";
import { callSonnet } from "../../core/llm/sonnet.ts";
import type { LmeBedrock } from "./harness.ts";

/** The helpers the boundary calls; tests replace them to inspect what they receive. */
export interface BoundaryCalls {
  embed?: typeof embedText;
  converse?: typeof callSonnet;
}

function singleAttemptClient(timeoutMs: number): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: awsRegion(),
    ...bedrockClientConfig(timeoutMs),
    retryMode: "standard",
    maxAttempts: 1,
  });
}

export function bedrockBoundary(calls: BoundaryCalls = {}): LmeBedrock {
  const embed = calls.embed ?? embedText;
  const converse = calls.converse ?? callSonnet;
  const embedClient = singleAttemptClient(embedTimeoutMs());
  const chatClient = singleAttemptClient(reasoningTimeoutMs());
  return {
    embed: async (text, modelId) => {
      let inputTokens = 0;
      const vector = await embed(text, { modelId, client: embedClient, onUsage: (u) => { inputTokens = u.inputTokens; } });
      return { vector, inputTokens };
    },
    converse: async ({ modelId, system, user, maxTokens }) => {
      const r = await converse({ system, user, maxTokens, temperature: 0 }, { modelId, operation: "longmemeval", client: chatClient });
      return { text: r.text, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    },
  };
}
