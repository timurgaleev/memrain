/**
 * Code chunk vectors: what a code chunk is embedded from, and the dollar cap a
 * run of code embeds is held to.
 *
 * The code indexer and `memrain embed --code` both embed through
 * `codeEmbeddingInput`, so a vector the backfill writes carries the same input
 * hash (migration 187) the indexer would compute, and a later re-index reuses
 * it instead of paying again.
 */
import { worstCaseUsd } from "./budget.ts";
import { wellFormForText } from "./well-form.ts";

/**
 * Longest code chunk text sent to the embedder, in UTF-16 units. A symbol can
 * be a whole 200 KB class, far past what Titan accepts; its head (signature,
 * doc comment, first members) is what a question about it matches anyway.
 */
export const CODE_EMBED_MAX_CHARS = 16_000;

/**
 * The embedding input for a code chunk: the chunk text raw (code is never
 * wrapped in a context prefix), well-formed exactly as the chunk is stored
 * (indexer-tx sanitizes NUL and lone surrogates), and capped. Applying it to
 * the raw text or to the stored `chunks.content` gives the same string.
 */
export function codeEmbeddingInput(text: string): string {
  const stored = wellFormForText(text);
  if (stored.length <= CODE_EMBED_MAX_CHARS) return stored;
  // A cut through a surrogate pair leaves a lone half: well-form it again.
  return wellFormForText(stored.slice(0, CODE_EMBED_MAX_CHARS));
}

/** Per-run cap for code embeds written by the sweep / `memrain index` (USD, worst case). */
export const DEFAULT_CODE_EMBED_MAX_USD = 1;

/**
 * `MEMRAIN_CODE_EMBED_MAX_USD`: how much one code sweep (or one `memrain index`
 * of a code file) may reserve for embeddings, priced at the worst case. `0`
 * stops the sweep paying at all; its chunks then wait for `memrain embed
 * --code`. A malformed value falls back to the default.
 */
export function codeEmbedMaxUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMRAIN_CODE_EMBED_MAX_USD?.trim();
  if (!raw) return DEFAULT_CODE_EMBED_MAX_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CODE_EMBED_MAX_USD;
}

/**
 * A dollar ceiling for a run of embedding calls. Each call reserves its worst
 * case (UTF-8 bytes plus framing, the bound the spend wallet holds) BEFORE it
 * is sent, synchronously, so concurrent workers sharing one cap can never pass
 * the same headroom. A reservation is kept even when the call fails: a sent
 * request may have billed.
 *
 * The run stops at the first call that does not fit, or when a caller reports
 * a failure every later call would repeat (`stop`); from then on nothing is
 * reserved and `stopReason` says why.
 */
export class EmbedSpendCap {
  private reserved = 0;
  private calls = 0;
  private stopped: string | null = null;

  constructor(readonly maxUsd: number) {}

  /** Reserve one call; false (nothing reserved) once the run has stopped or the call would cross the cap. */
  tryReserve(model: string, input: string): boolean {
    if (this.stopped !== null) return false;
    const usd = worstCaseUsd({ operation: "embedding", model, worstCase: { input, maxOutputTokens: 0 } });
    if (usd === null) {
      this.stopped = `no price for embedding model '${model}'`;
      return false;
    }
    if (this.reserved + usd > this.maxUsd) {
      this.stopped = `embedding cap of $${this.maxUsd} reached`;
      return false;
    }
    this.reserved += usd;
    this.calls++;
    return true;
  }

  /** Stop the run: no later call is reserved. The first reason is kept. */
  stop(reason: string): void {
    this.stopped ??= reason;
  }

  get stopReason(): string | null {
    return this.stopped;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  get reservedCalls(): number {
    return this.calls;
  }
}
