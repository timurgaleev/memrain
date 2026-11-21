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
 * Longest code chunk text sent to the embedder, in UTF-8 bytes. A symbol can
 * be a whole 200 KB class, far past what Titan accepts; its head (signature,
 * doc comment, first members) is what a question about it matches anyway.
 * Titan v2 takes 8,192 tokens and its tokenizer never makes more tokens than
 * bytes, so a byte cap under that holds for dense text too (hex, base64,
 * minified code, CJK), where a character cap does not.
 */
export const CODE_EMBED_MAX_BYTES = 8_000;

/**
 * A model refusal of a code chunk's text repeats on every try (the input is
 * deterministic), so `memrain embed --code` tries such a chunk once and then
 * walks past it; a re-index of its file starts it again at zero.
 */
export const CODE_EMBED_MAX_FAILURES = 1;

/**
 * The embedding input for a code chunk: the chunk text raw (code is never
 * wrapped in a context prefix), well-formed exactly as the chunk is stored
 * (indexer-tx sanitizes NUL and lone surrogates), and cut on a code point at
 * CODE_EMBED_MAX_BYTES. Applying it to the raw text or to the stored
 * `chunks.content` gives the same string.
 */
export function codeEmbeddingInput(text: string): string {
  const stored = wellFormForText(text);
  if (Buffer.byteLength(stored, "utf8") <= CODE_EMBED_MAX_BYTES) return stored;
  let bytes = 0;
  let end = 0;
  for (const ch of stored) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > CODE_EMBED_MAX_BYTES) break;
    bytes += size;
    end += ch.length;
  }
  return stored.slice(0, end);
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
