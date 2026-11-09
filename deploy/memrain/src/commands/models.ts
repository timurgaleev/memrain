import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { withStorage } from "./with-storage.ts";
import { resolveModelWithSource, type ModelTier, type ModelFeature } from "../core/llm/resolve-model.ts";
import { callSonnet } from "../core/llm/sonnet.ts";
import { classifyBedrockError, bedrockFixHint } from "../core/llm/bedrock-errors.ts";
import { BudgetTracker, priceFor, isBudgetRefusal } from "../core/budget.ts";
import { runtimeOverlayState } from "../core/runtime-config.ts";

const MODEL_ROWS: readonly { tier: ModelTier; feature?: ModelFeature }[] = [
  { tier: "utility" }, { tier: "reasoning" }, { tier: "deep" },
  { tier: "utility", feature: "intent" }, { tier: "utility", feature: "expansion" },
  { tier: "utility", feature: "rerank" }, { tier: "utility", feature: "concepts" },
  { tier: "reasoning", feature: "think" }, { tier: "reasoning", feature: "drift" },
  { tier: "reasoning", feature: "facts_extract" },
];

export async function runModels(opts: {
  probe?: boolean; json?: boolean; maxCostUsd?: number; configPath?: string; client?: BedrockRuntimeClient;
} = {}): Promise<number> {
  const maxCost = opts.maxCostUsd ?? 0.01;
  if (!Number.isFinite(maxCost) || maxCost < 0) throw new Error("memrain models: --max-cost-usd must be non-negative and finite");
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const models = MODEL_ROWS.map(row => {
      const resolved = resolveModelWithSource(row.tier, undefined, row.feature);
      return { ...row, ...resolved, price: priceFor(resolved.model) };
    });
    const probes: { model: string; status: string; hint?: string }[] = [];
    if (opts.probe) {
      const budget = new BudgetTracker(maxCost, "models-probe");
      for (const model of new Set(models.map(row => row.model))) {
        const hold = budget.reserve(model, { inputTokens: 128, outputTokens: 1 });
        if (!hold) { probes.push({ model, status: "budget_refused", hint: "Inspect the registered price and --max-cost-usd cap." }); continue; }
        try {
          const result = await callSonnet({ system: "Reply OK.", user: "Ping.", maxTokens: 1 },
            { modelId: model, operation: "models-probe", ...(opts.client ? { client: opts.client } : {}) });
          budget.settle(hold, model, result.usage);
          probes.push({ model, status: "ok" });
        } catch (error) {
          // A failed transport may have been billed. Keep its worst-case cost
          // against this run's cap rather than spending the hold again.
          if (!hold.done) budget.settle(hold, model, { inputTokens: 128, outputTokens: 1 });
          const status = isBudgetRefusal(error) ? "budget_refused" : classifyBedrockError(error);
          probes.push({ model, status, hint: status === "budget_refused" ? "Inspect the daily spend budget." : bedrockFixHint(status, model) });
        }
      }
    }
    const ok = probes.every(p => p.status === "ok");
    const report = { ok, models, probes, runtime_overlay: runtimeOverlayState(storage.engine()), max_cost_usd: maxCost };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("Tier / feature | model | origin | registered USD / 1M tokens (input / output)");
      for (const row of models) console.log(`${row.tier}${row.feature ? '/' + row.feature : ''} | ${row.model} | ${row.source}${row.key ? ':' + row.key : ''} | ${row.price ? `${row.price.inputPer1M} / ${row.price.outputPer1M}` : 'UNPRICED'}`);
      for (const probe of probes) console.log(`${probe.model}: ${probe.status}${probe.hint ? ' — ' + probe.hint : ''}`);
    }
    return ok ? 0 : 1;
  });
}
