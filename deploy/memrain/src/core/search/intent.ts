/**
 * Query intent classifier — zero-LLM regex by default.
 *
 * Distinguishes between:
 *   - factual:    "when did X happen", "what is X"
 *   - topic:      broad-recall lookups, "everything about Y"
 *   - howto:      procedural questions, "how do I X"
 *   - personal:   diary / journal queries, "what was I working on"
 *   - exact:      exact-phrase / fragment lookups, often quoted
 *
 * Used by source-boost (factual queries lean canonical; topic queries
 * benefit from broader recall) and dedup (exact queries skip dedup —
 * user might want all matching fragments).
 *
 * Classification is a pure regex taxonomy that never spends an LLM call on the
 * search hot path. The cheap heuristics run first, then the query-intent
 * taxonomy maps onto memrain's intent set (entity→factual, temporal→personal,
 * event/general→topic). The old Claude Haiku fallback survives behind
 * MEMRAIN_INTENT_LLM=1 for operators who want the paid tie-break on unmatched
 * queries.
 */
import { resolveModel } from "../llm/resolve-model.ts";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { classifyQueryTaxonomy } from "./query-intent.ts";
import { awsRegion, bedrockClientConfig, generationFields, responseText, SEARCH_LLM_BUDGET_MS, utilityTimeoutMs, withDeadline } from "../llm/gateway.ts";
import { isBudgetRefusal, trackedInvoke } from "../budget.ts";

export type Intent = "factual" | "topic" | "howto" | "personal" | "exact";

export const VALID_INTENTS: ReadonlySet<Intent> = new Set([
  "factual",
  "topic",
  "howto",
  "personal",
  "exact",
]);


let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region, ...bedrockClientConfig(utilityTimeoutMs()) });
  return _client;
}

export interface ClassifyIntentOptions {
  modelId?: string;
  region?: string;
  /** Override the Bedrock client (tests pass a stub), as embedding.ts does. */
  client?: BedrockRuntimeClient;
}

/** Ledger label — the opt-in paid tie-break behind MEMRAIN_INTENT_LLM=1. */
const SPEND_OP = "intent-classify";

const SYSTEM_PROMPT = `You are a search-intent classifier. Given a user query, output exactly one word from this set: factual, topic, howto, personal, exact. Output nothing else.`;

/**
 * Map the query taxonomy onto memrain's intent set. `temporal` leans
 * `personal` (diary/journal recall — a vector-leaning RRF profile with a
 * recency tilt); `event`/`general` stay `topic` (broad recall).
 */
function taxonomyToIntent(query: string): Intent {
  switch (classifyQueryTaxonomy(query)) {
    case "entity":
      return "factual";
    case "temporal":
      return "personal";
    default:
      return "topic";
  }
}

export async function classifyIntent(
  query: string,
  opts: ClassifyIntentOptions = {},
): Promise<Intent> {
  const trimmed = query.trim();
  if (!trimmed) return "topic";

  // Cheap heuristics first — obvious cases never reach the taxonomy or LLM.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return "exact";
  if (/\bhow (?:do|to|can|should)\b/i.test(trimmed)) return "howto";
  if (/\b(?:when|what|who|where|which) (?:is|was|did)\b/i.test(trimmed)) return "factual";

  // Zero-LLM default: the regex taxonomy decides. The paid Haiku call fires
  // ONLY when the operator opted back in via MEMRAIN_INTENT_LLM=1.
  if (process.env.MEMRAIN_INTENT_LLM !== "1") {
    return taxonomyToIntent(trimmed);
  }

  const region = opts.region ?? awsRegion();
  const modelId = resolveModel("utility", opts.modelId, "intent");
  const c = opts.client ?? client(region);
  try {
    return await trackedInvoke(
      { operation: SPEND_OP, model: modelId, worstCase: { input: SYSTEM_PROMPT + trimmed, maxOutputTokens: 8 } },
      async (meter) => {
      const resp = await withDeadline(SEARCH_LLM_BUDGET_MS, (abortSignal) =>
        c.send(
          new ConverseCommand({
            modelId,
            system: [{ text: SYSTEM_PROMPT }],
            messages: [{ role: "user", content: [{ text: trimmed }] }],
            ...generationFields(modelId, 8, 0),
          }),
          { abortSignal },
        ),
      );
      if (resp.usage) {
        meter.report({
          inputTokens: resp.usage.inputTokens ?? 0,
          outputTokens: resp.usage.outputTokens ?? 0,
        });
      }
      const text =
        responseText(resp.output?.message?.content)?.trim().toLowerCase() ?? "";
      const word = text.split(/\s+/)[0] ?? "";
      if (VALID_INTENTS.has(word as Intent)) return word as Intent;
      return taxonomyToIntent(trimmed);
    });
  } catch (err) {
    if (isBudgetRefusal(err)) throw err;
    // Network blip / model unavailable → the zero-LLM taxonomy still answers.
    return taxonomyToIntent(trimmed);
  }
}
