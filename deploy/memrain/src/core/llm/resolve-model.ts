/**
 * Unified model-tier resolver — the single seam for choosing a Bedrock model id
 * by tier, replacing the per-helper env lookups duplicated across haiku.ts and
 * sonnet.ts. memrain is Anthropic-only via Bedrock, so this is env + code only —
 * no multi-provider config-table / alias-map / subagent machinery.
 *
 * Tiers:
 *   - `utility`   → Haiku (fast/cheap classification, extraction).
 *   - `reasoning` → Sonnet (synthesis, facts, grading).
 *   - `deep`      → opt-in Opus (`MEMRAIN_DEEP_MODEL`); OFF by default, in which
 *                   case it falls back to the reasoning model so nothing regresses.
 *
 * Precedence: explicit `override` > the feature's own env var
 * (`MEMRAIN_<FEATURE>_MODEL`, when the caller names a feature) > tier env var >
 * built-in default. A feature key lets one call site move to another model —
 * query expansion to a newer Haiku, say — without moving its whole tier.
 * Uses `||` (not `??`) so an empty-string env (a `${VAR:-}` compose default)
 * falls through to the built-in, mirroring the existing helper behaviour.
 */
import { DEFAULT_HAIKU_MODEL } from "./haiku.ts";
import { DEFAULT_SONNET_MODEL } from "./sonnet.ts";

export type ModelTier = "utility" | "reasoning" | "deep";

const TIER_ENV: Record<ModelTier, string> = {
  utility: "MEMRAIN_UTILITY_MODEL",
  reasoning: "MEMRAIN_FACTS_MODEL",
  deep: "MEMRAIN_DEEP_MODEL",
};

// Read the built-in defaults at CALL time (function-local), never at module
// init — haiku.ts / sonnet.ts import back into this module, and reading their
// `export const`s at init would race the circular load. Call-time is safe.
function tierDefault(tier: ModelTier): string {
  if (tier === "utility") return DEFAULT_HAIKU_MODEL;
  if (tier === "reasoning") return DEFAULT_SONNET_MODEL;
  return ""; // deep has no built-in default — it is opt-in
}

/** Call sites with a model key of their own (`MEMRAIN_<FEATURE>_MODEL`).
 *  `facts_extract` reads `MEMRAIN_FACTS_EXTRACT_MODEL`: fact extraction can move
 *  to a cheaper tier once the fidelity bench's live lane has measured it, without
 *  moving every other reasoning-tier slice that shares `MEMRAIN_FACTS_MODEL`. */
export type ModelFeature =
  | "think"
  | "drift"
  | "concepts"
  | "expansion"
  | "intent"
  | "rerank"
  | "facts_extract";

/** Resolve the Bedrock model id for a tier. `deep` with no override/env falls
 *  back to the reasoning model (Sonnet), so enabling the tier is a deliberate,
 *  cost-guarded opt-in and disabling it never regresses. */
export function resolveModel(tier: ModelTier, override?: string, feature?: ModelFeature): string {
  const featureEnv = feature ? process.env[`MEMRAIN_${feature.toUpperCase()}_MODEL`] : undefined;
  const v = override || featureEnv || process.env[TIER_ENV[tier]] || tierDefault(tier);
  return tier === "deep" && !v ? tierDefault("reasoning") : v;
}
