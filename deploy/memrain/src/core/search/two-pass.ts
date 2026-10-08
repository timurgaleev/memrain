/**
 * Two-pass rerank — feed the top-K hybrid hits to Haiku 4.5 for a more
 * precise relevance score, return the new ordering.
 *
 * Opt-in via env `MEMRAIN_RERANK=1` because Haiku is paid (~$1-3/mo
 * for typical use). Cheap users keep the RRF + source-boost ordering.
 *
 * Designed to fail safe: any error returns the input order unchanged AND is
 * recorded to the rerank-failure audit JSONL (rerank-audit.ts, opt-in via
 * MEMRAIN_AUDIT_DIR) so silent degradation is greppable. The Bedrock call runs
 * under a per-call wall-clock timeout (MEMRAIN_RERANK_TIMEOUT_MS, default
 * 5000ms) so a hung connection can't stall search.
 */
import { resolveModel } from "../llm/resolve-model.ts";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ChunkScore } from "./dedup.ts";
import {
  hashQueryForAudit,
  logRerankFailure,
  type RerankFailureReason,
} from "./rerank-audit.ts";
import { awsRegion, generationFields, responseText } from "../llm/gateway.ts";
import { trackedInvoke } from "../budget.ts";


/** Ledger label — the opt-in paid rerank behind MEMRAIN_RERANK=1. */
const SPEND_OP = "rerank-two-pass";

/** Per-call rerank timeout (ms). Default: 5000. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Output cap for the rerank call — one line of indices, nothing else. */
const MAX_OUTPUT_TOKENS = 200;

/**
 * The index array, salvaged out of any wrapping prose. The span is bounded by
 * the call's own output cap (MAX_OUTPUT_TOKENS at the 4-chars-per-token
 * estimate this codebase uses), which is far more than the `[3,0,1,2,4]` the
 * prompt asks for. Unbounded, `/\[[^\]]*\]/` re-scanned to the end of the
 * string from every `[`: a 16 K run of `[` measured 96 ms through rerank(),
 * ratio 3.81-4.05 on a doubling (quadratic).
 */
const INDEX_ARRAY = new RegExp(`\\[[^\\]]{0,${MAX_OUTPUT_TOKENS * 4}}\\]`);

function rerankTimeoutMs(): number {
  const n = Number(process.env.MEMRAIN_RERANK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

export interface ChunkPayloadForRerank {
  content: string;
  title: string | null;
  sourcePath: string;
}

export interface RerankOptions {
  modelId?: string;
  region?: string;
  /** Per-call timeout override (ms). Defaults to MEMRAIN_RERANK_TIMEOUT_MS/5000. */
  timeoutMs?: number;
  /** Override the Bedrock client (tests pass a stub), as embedding.ts does. */
  client?: BedrockRuntimeClient;
}

const SYSTEM_PROMPT = `You are a relevance reranker. You see a search query and a list of candidate chunks (numbered 0..N-1). Output ONE LINE: a JSON array of indices, in the order most-to-least relevant to the query. Output nothing else. Example: [3,0,1,2,4]`;

export async function rerank<T extends ChunkPayloadForRerank>(
  query: string,
  hits: readonly ChunkScore<T>[],
  opts: RerankOptions = {},
): Promise<ChunkScore<T>[]> {
  if (hits.length <= 1) return [...hits];
  const items = hits.map((h, i) => {
    const title = h.payload?.title ?? "(untitled)";
    const path = h.payload?.sourcePath ?? "";
    const snippet = (h.payload?.content ?? "").slice(0, 600).replace(/\s+/g, " ");
    return `${i}: [${title} — ${path}] ${snippet}`;
  });
  const userMessage = `QUERY: ${query}\n\nCANDIDATES:\n${items.join("\n")}`;

  const region = opts.region ?? awsRegion();
  const modelId = resolveModel("utility", opts.modelId, "rerank");
  const timeoutMs = opts.timeoutMs ?? rerankTimeoutMs();
  const c = opts.client ?? client(region);

  const audit = (reason: RerankFailureReason, err: unknown): void => {
    logRerankFailure({
      model: modelId,
      reason,
      query_hash: hashQueryForAudit(query),
      doc_count: hits.length,
      error_summary: err instanceof Error ? err.message : String(err),
    });
  };

  try {
    return await trackedInvoke(
      {
        operation: SPEND_OP,
        model: modelId,
        worstCase: { input: SYSTEM_PROMPT + userMessage, maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
      async (meter) => {
      const resp = await c.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content: [{ text: userMessage }] }],
          ...generationFields(modelId, MAX_OUTPUT_TOKENS, 0),
        }),
        // Per-call deadline: a stuck upstream must not hold search hostage.
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
      if (resp.usage) {
        meter.report({
          inputTokens: resp.usage.inputTokens ?? 0,
          outputTokens: resp.usage.outputTokens ?? 0,
        });
      }
      const text = responseText(resp.output?.message?.content)?.trim() ?? "[]";
      const match = text.match(INDEX_ARRAY);
      if (!match) {
        audit("parse", `no index array in model output (${text.slice(0, 80)})`);
        return [...hits];
      }
      const order = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(order)) {
        audit("parse", "model output parsed to a non-array");
        return [...hits];
      }
      const seen = new Set<number>();
      const out: ChunkScore<T>[] = [];
      let rerankedScore = hits.length;
      for (const idx of order) {
        if (
          typeof idx === "number" &&
          Number.isInteger(idx) &&
          idx >= 0 &&
          idx < hits.length &&
          !seen.has(idx)
        ) {
          const h = hits[idx]!;
          out.push({ ...h, score: rerankedScore-- });
          seen.add(idx);
        }
      }
      // Append any candidates the rerank missed in original order.
      for (let i = 0; i < hits.length; i++) {
        if (!seen.has(i)) {
          out.push(hits[i]!);
        }
      }
      return out;
    });
  } catch (err) {
    // A budget refusal lands here too: the search already has its results, so
    // they are returned un-reranked rather than failed after the fact.
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    audit(timedOut ? "timeout" : "upstream", err);
    return [...hits];
  }
}
