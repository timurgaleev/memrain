/**
 * Deterministic basis-vector embedder for hermetic retrieval tests.
 *
 * Maps text → a fixed 1024-dim (the production Titan dimension, so it fits the
 * `vector(1024)` column) unit vector by hashing each token to a dimension and
 * accumulating term frequency, then L2-normalizing. Two texts that share terms
 * get a small cosine distance (pgvector `<=>`), so the vector arm ranks
 * shared-vocabulary docs near a query — WITHOUT any Bedrock call. Pure +
 * deterministic: identical input always yields the identical vector, so a
 * retrieval-quality gate built on it is reproducible in CI.
 *
 * The hermetic tests and the search bench (`memrain eval bench`) use it; no
 * production write or search path does. It is intentionally a bag-of-words
 * proxy, not a semantic model — enough to exercise the real vector + keyword +
 * RRF fusion path deterministically and for free.
 */

const DIM = 1024;

/**
 * Tiny synonym table: distinct surface tokens that canonicalize to the SAME
 * dimension. This is what makes the embedder a (toy) SEMANTIC signal rather
 * than a pure bag-of-words — a query token can bridge to a different doc token
 * that the keyword/FTS arm would never match. Without this the vector arm and
 * the keyword arm carry identical signal (token overlap), and a hermetic gate
 * could pass with a totally broken vector arm. Keep it small + obvious.
 */
const SYNONYMS: Record<string, string> = {
  automobile: "car",
  vehicle: "car",
  auto: "car",
  servicing: "maintenance",
  repair: "maintenance",
  servicemen: "maintenance",
};

/** Canonicalize a token through the synonym table (identity if unmapped). */
function canonical(token: string): string {
  return SYNONYMS[token] ?? token;
}

/** FNV-1a 32-bit hash → a stable dimension index in [0, DIM). */
function tokenDim(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DIM;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Deterministically embed `text` into a 1024-dim unit vector. An empty / all-
 * punctuation string maps to a fixed unit vector (dimension 0 = 1) so it never
 * produces a zero vector (which would make cosine distance undefined).
 */
export function deterministicEmbed(text: string): number[] {
  const v = Array.from<number>({ length: DIM }).fill(0);
  for (const tok of tokenize(text)) {
    const di = tokenDim(canonical(tok));
    v[di] = (v[di] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/** Async adapter matching the hybridSearch `embedQuery` injection signature. */
export async function deterministicEmbedQuery(text: string): Promise<number[]> {
  return deterministicEmbed(text);
}
