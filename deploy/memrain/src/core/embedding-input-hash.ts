/**
 * What a stored vector was embedded from (`embeddings.input_hash`, migration
 * 187).
 *
 * The hash digests the model, the vector width, the contextual tier and the
 * embedding input. For the raw and deterministic tiers the input is the exact
 * text sent to the embedder (the `<context>` prefix plus the chunk), so a title
 * or synopsis change moves the hash of every wrapped chunk. The LLM tier's
 * per-chunk context cannot be recomputed without paying for it again, so its
 * input is the page title plus the chunk text: a retitle re-embeds, an edit
 * elsewhere in the page does not (the same tradeoff text-keyed reuse made for
 * every tier before).
 *
 * A NULL hash (every vector written before migration 187, and vectors other
 * writers produce) means the provenance is unknown; the indexer falls back to
 * reusing it by chunk text, model and width.
 */
import { createHash } from "node:crypto";

export type EmbeddingInputTier = "none" | "deterministic" | "llm";

export interface EmbeddingInputParts {
  model: string;
  dimensions: number;
  tier: EmbeddingInputTier;
  /** The exact embed input for `none` / `deterministic`; the chunk text for `llm`. */
  input: string;
  /** Page title the LLM tier's context was written for; ignored by the other tiers. */
  title?: string | null;
}

const HASH_VERSION = "embedding-input-v1";

export function embeddingInputHash(parts: EmbeddingInputParts): string {
  const fields = [
    HASH_VERSION,
    parts.model,
    String(parts.dimensions),
    parts.tier,
    parts.tier === "llm" ? (parts.title ?? "") : "",
    parts.input,
  ];
  // Length-prefixed so no two field lists can join into the same byte string.
  const h = createHash("sha256");
  for (const f of fields) h.update(`${Buffer.byteLength(f, "utf8")}:${f}\n`, "utf8");
  return h.digest("hex");
}
