/**
 * Thin shared Bedrock Claude Haiku call helper.
 *
 * memrain already calls the utility LLM in two places (search/intent.ts,
 * search/expansion.ts), but each instantiates its own BedrockRuntimeClient +
 * hand-rolls the ConverseCommand. The synthesis subsystem (Wave 5) adds five
 * more LLM call sites, so this consolidates the single "send a system+user
 * prompt, get text back" shape into one place. The existing two callers are NOT
 * migrated here (surgical-change rule); they keep their own clients.
 *
 * Design:
 *   - One reused client per region (same lazy-singleton pattern as intent.ts).
 *   - `LlmFn` is the injectable seam every synthesis phase accepts so tests run
 *     hermetically with a fake — NO live Bedrock in tests, mirroring how
 *     intent/expansion expose their model behind a default that tests bypass.
 *   - Fail-open is the CALLER's job: this helper throws on a Bedrock error; the
 *     phase wraps it in try/catch so one bad call skips, never corrupts.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ValidationException,
  type ContentBlock,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { resolveModel } from "./resolve-model.ts";
import {
  awsRegion,
  bedrockClientConfig,
  chatTimeoutMs,
  generationFields,
  responseText,
  utilityTimeoutMs,
  withInflightCap,
} from "./gateway.ts";
import { trackedInvoke } from "../budget.ts";

/** Default utility model — Claude Haiku (Bedrock), identical to intent.ts / expansion.ts. */
export const DEFAULT_HAIKU_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface LlmUsage {
  /** Non-cached input tokens billed at the normal input rate. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache — billed at ~10% of the input rate. */
  cacheReadInputTokens?: number;
  /** Tokens written to the prompt cache — billed at ~125% of the input rate. */
  cacheWriteInputTokens?: number;
}

export interface LlmCallInput {
  /** System prompt — the instruction. */
  system: string;
  /** User turn — the (untrusted) content. */
  user: string;
  /** Hard cap on output tokens. Required — synthesis callers size this per phase. */
  maxTokens: number;
  /** Sampling temperature. Default 0 (deterministic-as-possible). */
  temperature?: number;
  /**
   * Optional cacheable leading block for the USER turn. When set, it is sent as
   * its own content block followed by a Bedrock `cachePoint`, so a model/region
   * that supports prompt caching caches this prefix and reuses it across calls
   * that share the SAME prefix (e.g. one document across all of its chunks). The
   * `user` field then carries only the uncached remainder (the per-call tail).
   * Fail-safe: a model/region that rejects the `cachePoint` (ValidationException)
   * is retried once as a single uncached block, so the call still succeeds.
   */
  cachePrefix?: string;
}

export interface LlmCallResult {
  /** The model's text output (already trimmed of the envelope, not of content). */
  text: string;
  /** Resolved model id used for the call — recorded as provenance on synthesis rows. */
  modelId: string;
  /** Token usage when the transport exposes it (Bedrock Converse). Absent for a
   *  fake seam that returns none — callers then fall back to an estimate. */
  usage?: LlmUsage;
  /**
   * Bedrock Converse's `stopReason` — same field, same values, same optionality
   * as the reasoning tier's (`SonnetCallResult.stopReason`, whose
   * `STOP_REASON_MAX_TOKENS` names the output-cap case). The utility tier parses
   * structured output too — take proposals, judge verdicts — and without this a
   * payload the cap cut in half is indistinguishable from a model that had
   * nothing to say. Optional so the injected fakes that predate it keep
   * typechecking.
   */
  stopReason?: string;
}

/**
 * The injectable LLM seam. Production wires `callHaiku`; tests pass a fake that
 * returns canned text without any network call. Every synthesis phase takes one
 * of these as `opts.llmFn`.
 */
export type LlmFn = (input: LlmCallInput) => Promise<LlmCallResult>;

// Keyed by region: a process may call the utility LLM in more than one region,
// and a bare singleton would pin every later call to whichever region happened
// first.
const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region, ...bedrockClientConfig(utilityTimeoutMs()) });
    _clients.set(region, c);
  }
  return c;
}

export interface LlmCallOptions {
  modelId?: string;
  region?: string;
  /**
   * Feature label this call's cost is booked under in the spend ledger. A
   * caller that already names itself for a BudgetTracker should pass the SAME
   * label here, so the ledger and the cap agree on whose dollar it is. Callers
   * that name nothing land in the tier bucket below — honest, just coarse.
   */
  operation?: string;
  /** Override the Bedrock client. `LlmFn` is the seam for faking the CALL;
   *  this is the seam for exercising the transport itself (usage extraction,
   *  the cachePoint retry) without a network. */
  client?: BedrockRuntimeClient;
}

/** Ledger label for a utility-tier call whose caller didn't name itself. */
export const DEFAULT_UTILITY_SPEND_OP = "utility-llm";

/**
 * Build the user-turn content blocks. With `withCache` and a `cachePrefix`, the
 * prefix is its own block followed by a `cachePoint`, then the uncached `user`
 * tail — so the cacheable segment is exactly the prefix. Otherwise it collapses
 * to a single text block (prefix + tail joined the same way the split reads on
 * the wire). Pure + exported so the cachePoint placement is unit-testable
 * without a live Bedrock client.
 */
export function buildUserContent(input: LlmCallInput, withCache: boolean): ContentBlock[] {
  if (withCache && input.cachePrefix) {
    // The separator lives on the UNCACHED tail block so the on-the-wire form
    // (prefix + "\n\n" + user) is byte-identical to the collapsed single-block
    // form below; only `cachePrefix` is the cached segment.
    return [
      { text: input.cachePrefix },
      { cachePoint: { type: "default" } },
      { text: `\n\n${input.user}` },
    ];
  }
  return [
    { text: input.cachePrefix ? `${input.cachePrefix}\n\n${input.user}` : input.user },
  ];
}

/**
 * Production utility-LLM call (Claude Haiku via Bedrock). Throws on any Bedrock
 * / network error — callers decide whether to fail-open. The returned `modelId`
 * is the resolved id (so a row's provenance reflects what actually ran, not a
 * guess).
 */
export async function callHaiku(
  input: LlmCallInput,
  opts: LlmCallOptions = {},
): Promise<LlmCallResult> {
  const region = opts.region ?? awsRegion();
  const modelId = resolveModel("utility", opts.modelId);
  const c = opts.client ?? client(region);

  const send = (withCache: boolean) =>
    withInflightCap(() =>
      c.send(
        new ConverseCommand({
          modelId,
          system: [{ text: input.system }],
          messages: [{ role: "user", content: buildUserContent(input, withCache) }],
          ...generationFields(modelId, input.maxTokens, input.temperature ?? 0),
        }),
        { requestTimeout: chatTimeoutMs(utilityTimeoutMs(), input.maxTokens) },
      ),
    );

  // Resolved across two branches. The spend chokepoint wraps BOTH attempts —
  // the cachePoint retry is one logical call, so its usage replaces the first
  // attempt's rather than booking a second row — and the response mapping stays
  // in the pure `toLlmCallResult`, which is what carries the stop reason a
  // structured-output caller reads.
  return trackedInvoke(
    {
      operation: opts.operation ?? DEFAULT_UTILITY_SPEND_OP,
      model: modelId,
      worstCase: {
        input: input.system + input.user,
        ...(input.cachePrefix ? { cachedInput: input.cachePrefix } : {}),
        maxOutputTokens: input.maxTokens,
      },
    },
    async (meter) => {
      let resp;
      try {
        resp = await send(true);
      } catch (err) {
        // Fail-safe: a model/region that can't cache rejects the `cachePoint`
        // with a ValidationException. Retry once as a single uncached block so
        // the call still succeeds — caching is a cost optimization, never a
        // correctness dependency.
        if (input.cachePrefix && err instanceof ValidationException) {
          resp = await send(false);
        } else {
          throw err;
        }
      }
      const result = toLlmCallResult(resp, modelId);
      if (result.usage) meter.report(result.usage);
      return result;
    },
  );
}

/**
 * Map a Converse response onto the caller-facing result. Pure + exported for the
 * same reason `buildUserContent` is: the transport's contract — text, usage and
 * the stop reason a structured-output caller reads — is then unit-testable
 * without a live Bedrock client.
 */
export function toLlmCallResult(
  resp: Pick<ConverseCommandOutput, "output" | "usage" | "stopReason">,
  modelId: string,
): LlmCallResult {
  const text = responseText(resp.output?.message?.content) ?? "";
  const u = resp.usage;
  const usage: LlmUsage | undefined = u
    ? {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        ...(u.cacheReadInputTokens != null
          ? { cacheReadInputTokens: u.cacheReadInputTokens }
          : {}),
        ...(u.cacheWriteInputTokens != null
          ? { cacheWriteInputTokens: u.cacheWriteInputTokens }
          : {}),
      }
    : undefined;
  // Omitted rather than set to undefined when absent, matching how the
  // reasoning tier carries it.
  return { text, modelId, usage, ...(resp.stopReason ? { stopReason: resp.stopReason } : {}) };
}

/**
 * Resolve the LlmFn a phase should use: the injected one (tests), else a
 * production closure over `callHaiku`. Keeps every phase's resolution identical.
 */
export function resolveLlmFn(injected: LlmFn | undefined, opts: LlmCallOptions = {}): LlmFn {
  return injected ?? ((input) => callHaiku(input, opts));
}
