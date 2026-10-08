/**
 * Bedrock Claude (Sonnet) call helper — the paid, higher-reasoning tier for
 * fact extraction and the opt-in paid slices. Mirrors the Haiku utility helper's
 * ConverseCommand shape but returns token usage so the BudgetTracker can price
 * each call.
 *
 * memrain runs the Claude Haiku utility tier everywhere EXCEPT this
 * higher-reasoning path (conversation→facts + the opt-in slices), where the
 * operator chose Sonnet for the notability/salience judgment Haiku is weaker at.
 * Sonnet runs through the SAME Bedrock account as Titan/Haiku — notes never leave
 * AWS — via an EU cross-region inference profile (`eu.anthropic.*`). The exact
 * profile id is config (`MEMRAIN_FACTS_MODEL`); confirm the version suffix in the
 * Bedrock console and widen `terraform/iam.tf` bedrock:InvokeModel to that ARN.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { resolveModel } from "./resolve-model.ts";
import {
  awsRegion,
  bedrockClientConfig,
  chatTimeoutMs,
  generationFields,
  reasoningTimeoutMs,
  responseText,
  withInflightCap,
} from "./gateway.ts";
import { trackedInvoke } from "../budget.ts";

/** EU cross-region inference profile for Claude Sonnet 4.6 — verified ACTIVE +
 *  invokable in eu-west-1 (no version suffix). Override via MEMRAIN_FACTS_MODEL
 *  (e.g. `eu.anthropic.claude-haiku-4-5-20251001-v1:0` for the cheaper tier). */
export const DEFAULT_SONNET_MODEL = "eu.anthropic.claude-sonnet-4-6";

export interface SonnetCallInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export interface SonnetUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SonnetCallResult {
  text: string;
  modelId: string;
  usage: SonnetUsage;
  /**
   * Bedrock Converse's `stopReason` — "end_turn", "max_tokens",
   * "stop_sequence", … A caller that parses structured output needs it to tell
   * a complete answer from one the output cap cut in half. Optional so the
   * injected test seams that predate it keep typechecking.
   */
  stopReason?: string;
}

/** Converse's stop reason when the model ran into the output-token cap. */
export const STOP_REASON_MAX_TOKENS = "max_tokens";

/** Injectable seam — production wires `callSonnet`; tests pass a fake. */
export type SonnetFn = (input: SonnetCallInput) => Promise<SonnetCallResult>;

const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region, ...bedrockClientConfig(reasoningTimeoutMs()) });
    _clients.set(region, c);
  }
  return c;
}

export interface CallSonnetOptions {
  modelId?: string;
  region?: string;
  /**
   * Feature label this call's cost is booked under in the spend ledger — the
   * same name the caller gives its BudgetTracker, so cap and ledger agree on
   * whose dollar it is. Unnamed callers land in the tier bucket below.
   */
  operation?: string;
  /** Override the Bedrock client. `SonnetFn` is the seam for faking the CALL;
   *  this is the seam for exercising the transport itself without a network. */
  client?: BedrockRuntimeClient;
}

/** Ledger label for a reasoning-tier call whose caller didn't name itself. */
export const DEFAULT_REASONING_SPEND_OP = "reasoning-llm";

/**
 * Resolve the paid-tier model id. Precedence: an explicit override → the
 * `MEMRAIN_FACTS_MODEL` env → the built-in default. Uses `||` (not `??`) so an
 * EMPTY-STRING env value — what a `${MEMRAIN_FACTS_MODEL:-}` docker-compose
 * passthrough injects when the operator hasn't set it — is treated as "unset"
 * and falls through to the real default. An empty model id would otherwise be
 * unpriced, and the budget guard would refuse to spend (silent "budget
 * exhausted before the call"). Every paid slice resolves its model through here.
 */
export function resolveFactsModel(override?: string): string {
  return resolveModel("reasoning", override);
}

/** Production Sonnet call. Throws on any Bedrock/network error — the caller's
 *  budget loop decides whether to record a pessimistic cost and stop. */
export async function callSonnet(
  input: SonnetCallInput,
  opts: CallSonnetOptions = {},
): Promise<SonnetCallResult> {
  const region = opts.region ?? awsRegion();
  const modelId = resolveFactsModel(opts.modelId);
  const c = opts.client ?? client(region);
  return trackedInvoke(
    {
      operation: opts.operation ?? DEFAULT_REASONING_SPEND_OP,
      model: modelId,
      worstCase: { input: input.system + input.user, maxOutputTokens: input.maxTokens },
    },
    async (meter) => {
      const resp = await withInflightCap(() =>
        c.send(
          new ConverseCommand({
            modelId,
            system: [{ text: input.system }],
            messages: [{ role: "user", content: [{ text: input.user }] }],
            ...generationFields(modelId, input.maxTokens, input.temperature ?? 0),
          }),
          { requestTimeout: chatTimeoutMs(reasoningTimeoutMs(), input.maxTokens) },
        ),
      );
      const text = responseText(resp.output?.message?.content) ?? "";
      const usage: SonnetUsage = {
        inputTokens: resp.usage?.inputTokens ?? 0,
        outputTokens: resp.usage?.outputTokens ?? 0,
      };
      meter.report(usage);
      return {
        text,
        modelId,
        usage,
        ...(resp.stopReason ? { stopReason: resp.stopReason } : {}),
      };
    },
  );
}

export function resolveSonnetFn(
  injected: SonnetFn | undefined,
  opts: CallSonnetOptions = {},
): SonnetFn {
  return injected ?? ((input) => callSonnet(input, opts));
}
