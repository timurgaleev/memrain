import type { Storage } from "./storage.ts";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Engine } from "./engine/interface.ts";
import { indexDocument, type EmbedFn } from "./indexer.ts";
import { indexCodeDocument } from "./indexer-code.ts";
import { embedText } from "./embedding.ts";
import { bedrockClientConfig, embedTimeoutMs } from "./llm/gateway.ts";
import { worstCaseUsd } from "./budget.ts";
import { lockPageSlugs } from "./pages.ts";
import { OperationError } from "./operation-error.ts";
import { buildRechunkPlan, loadRechunkInput, rechunkSnapshot, staleRechunkPlan,
  type RechunkOptions, type RechunkTarget, type RechunkSelection } from "./rechunk-plan.ts";

async function checkTarget(engine: Engine, target: RechunkTarget, selection: RechunkSelection, lock: boolean) {
  if (lock) {
    if (target.page_slug) await lockPageSlugs(engine, target.page_slug);
    await engine.query("SELECT id FROM documents WHERE id = $1 FOR UPDATE", [target.document_id]);
  }
  const input = await loadRechunkInput(engine, target, selection);
  if (input.inputHash !== target.input_hash || await rechunkSnapshot(engine, target.document_id) !== target.snapshot_hash) {
    throw staleRechunkPlan();
  }
  return input;
}

export async function applyRechunkPlan(storage: Storage, opts: RechunkOptions, planHash: string,
  dependencies: { embedFn?: typeof embedText } = {}) {
  const plan = await buildRechunkPlan(storage, opts);
  if (plan.plan_hash !== planHash) throw staleRechunkPlan();
  if (!plan.applicable) throw new Error("rechunk plan exceeds max-cost-usd or includes unsupported/unpriced model work");
  const completed: string[] = [];
  const skipped: Array<{ document_id: string; reason: string }> = [];
  const embed = dependencies.embedFn ?? embedText;
  let reservedUsd = 0;
  let embedCalls = 0;
  for (const target of plan.targets) {
    let client: BedrockRuntimeClient | undefined;
    try {
      const input = await checkTarget(storage.engine(), target, plan.selection, false);
      const beforeCommit = async (tx: Engine) => { await checkTarget(tx, target, plan.selection, true); };
      if (target.kind === "code") {
        const result = await indexCodeDocument(storage, {
          sourcePath: target.source_path, text: input.text, mtimeMs: input.mtimeMs,
          sourceId: target.source_id, expectOwner: target.source_id, beforeCommit, requireCompleteParse: true,
        });
        if (result.skipped) {
          skipped.push({ document_id: target.document_id, reason: "unsupported_code" });
          break;
        }
      } else {
        const boundedEmbed: EmbedFn = async (text, model) => {
          const cost = worstCaseUsd({ operation: "embedding", model: model.modelId,
            worstCase: { input: text, maxOutputTokens: 0 } });
          if (cost === null || reservedUsd + cost > plan.selection.max_cost_usd) {
            throw new OperationError("budget_exhausted", "rechunk embedding budget would be exceeded", "Preview a smaller batch.");
          }
          // Reserve before dispatch and retain the upper bound even on a failed response.
          reservedUsd += cost;
          embedCalls++;
          client ??= new BedrockRuntimeClient({ region: plan.selection.region, ...bedrockClientConfig(embedTimeoutMs()),
            maxAttempts: plan.selection.max_attempts, retryMode: "standard" });
          return embed(text, { ...model, client });
        };
        await indexDocument(storage, { sourcePath: target.source_path, text: input.text,
          sourceId: target.source_id, expectOwner: target.source_id, mtimeMs: input.mtimeMs,
          ...(input.extraFrontmatter ? { extraFrontmatter: input.extraFrontmatter } : {}),
        }, { inferFrontmatter: target.kind === "markdown", embeddingModel: plan.selection.model,
          embedFn: boundedEmbed, requireCompleteEmbeddings: true, beforeCommit });
      }
      completed.push(target.document_id);
    } catch (error) {
      skipped.push({ document_id: target.document_id, reason: error instanceof OperationError ? error.code : "target_failed" });
      break;
    } finally {
      client?.destroy();
    }
  }
  const remaining = plan.targets.map(t => t.document_id).filter(id => !completed.includes(id));
  return { ok: remaining.length === 0 && skipped.length === 0, status: remaining.length === 0 && skipped.length === 0 ? "complete" : "partial",
    plan_hash: plan.plan_hash, completed, skipped, remaining, held: plan.held,
    reserved_cost_upper_bound_usd: reservedUsd, embedding_calls: embedCalls };
}
