/**
 * Shared handling for a paid call that stopped on the output cap.
 *
 * The facts extractor proved the shape: when Bedrock reports
 * `stopReason: "max_tokens"`, the response is cut mid-structure, the parser
 * discards it, and the caller reports "nothing found" for content that was
 * never emitted. Retrying at the SAME cap cannot help — these calls run at
 * temperature 0, so the identical prompt truncates in the identical place.
 * The retry has to buy more room, and only when the caller's budget says the
 * second call fits.
 *
 * This module is the one implementation of that; call sites supply a `call`
 * closure taking the cap, and a `canAffordRetry` predicate. Without the
 * predicate there is no retry: an unbudgeted second call against a paid model
 * is never the safe default.
 */
import {
  STOP_REASON_MAX_TOKENS,
  type SonnetCallResult,
  type SonnetUsage,
} from "./sonnet.ts";
import { truncationRetryCap } from "./output-limits.ts";

export interface TruncationRetryResult {
  /** The response to parse — the retry's when one ran, else the first call's. */
  resp: SonnetCallResult;
  /** Token usage summed across every call made, for the caller's budget. */
  usage: SonnetUsage;
  /** True when a second, larger call was made. */
  retried: boolean;
  /** True when the response the caller gets was still cut off. */
  truncated: boolean;
}

export function isTruncated(resp: Pick<SonnetCallResult, "stopReason">): boolean {
  return resp.stopReason === STOP_REASON_MAX_TOKENS;
}

export async function callWithTruncationRetry(
  label: string,
  maxTokens: number,
  call: (cap: number) => Promise<SonnetCallResult>,
  canAffordRetry?: (projected: SonnetUsage) => boolean,
): Promise<TruncationRetryResult> {
  const first = await call(maxTokens);
  let usage: SonnetUsage = first.usage;
  if (!isTruncated(first)) {
    return { resp: first, usage, retried: false, truncated: false };
  }

  const retryCap = truncationRetryCap(maxTokens);
  if (retryCap === null) {
    process.stderr.write(
      `[${label}] WARN: output truncated at maxTokens=${maxTokens} (model=${first.modelId}); ` +
        `already at the ceiling — this answer is incomplete\n`,
    );
    return { resp: first, usage, retried: false, truncated: true };
  }

  // The retry replays the identical prompt, so its input matches the first
  // call's actuals; only the output is open-ended, and retryCap bounds it.
  const projected: SonnetUsage = {
    inputTokens: usage.inputTokens * 2,
    outputTokens: usage.outputTokens + retryCap,
  };
  if (!(canAffordRetry?.(projected) ?? false)) {
    process.stderr.write(
      `[${label}] WARN: output truncated at maxTokens=${maxTokens} (model=${first.modelId}); ` +
        `no budget for a retry — this answer is incomplete\n`,
    );
    return { resp: first, usage, retried: false, truncated: true };
  }

  process.stderr.write(
    `[${label}] WARN: output truncated at maxTokens=${maxTokens} (model=${first.modelId}); ` +
      `retrying once at ${retryCap}\n`,
  );
  const retry = await call(retryCap);
  usage = {
    inputTokens: usage.inputTokens + retry.usage.inputTokens,
    outputTokens: usage.outputTokens + retry.usage.outputTokens,
  };
  const stillTruncated = isTruncated(retry);
  if (stillTruncated) {
    process.stderr.write(
      `[${label}] WARN: output STILL truncated at maxTokens=${retryCap} ` +
        `(model=${retry.modelId}); this answer is incomplete\n`,
    );
  }
  return { resp: retry, usage, retried: true, truncated: stillTruncated };
}
