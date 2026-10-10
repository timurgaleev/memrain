/**
 * Per-document dedup. After RRF the top-k can have multiple chunks from
 * the same document. For a hybrid search UX we usually want one hit
 * per doc (highest-scoring chunk wins) so the user sees a diverse set.
 *
 * Caller may keep all chunks if a query is "show me everything about
 * this exact note" — pass `enabled: false`.
 */

export interface ChunkScore<T = unknown> {
  chunkId: string;
  documentId: string;
  score: number;
  payload?: T;
}

export interface DedupOptions {
  enabled?: boolean;
  /** How many chunks per doc to keep. Default 1. */
  maxPerDoc?: number;
  /** Group by this key instead of documentId (a page spanning several documents). */
  keyOf?: (hit: ChunkScore<unknown>) => string;
}

export function dedupByDocument<T>(
  hits: readonly ChunkScore<T>[],
  opts: DedupOptions = {},
): ChunkScore<T>[] {
  if (opts.enabled === false) return [...hits];
  const cap = opts.maxPerDoc ?? 1;
  const counts = new Map<string, number>();
  const out: ChunkScore<T>[] = [];
  for (const h of hits) {
    const key = opts.keyOf ? opts.keyOf(h) : h.documentId;
    const c = counts.get(key) ?? 0;
    if (c < cap) {
      out.push(h);
      counts.set(key, c + 1);
    }
  }
  return out;
}

/**
 * Near-duplicate dedup by text similarity (Jaccard on word sets) — an additive
 * stage after the per-document dedup. Per-doc dedup keeps the best chunk PER
 * doc, but two DIFFERENT documents can still carry near-identical text (e.g. a
 * note and its `.bak` copy); this drops a hit whose content is too similar to a
 * higher-ranked already-kept hit. Greedy + rank-order-preserving (the first,
 * higher-scored occurrence wins).
 *
 * A text-similarity dedup stage. Other dedup layers are not folded in here:
 * type-diversity needs a page-type taxonomy this stage doesn't carry, and the
 * compiled-truth guarantee is an LLM-cycle artifact memrain doesn't produce.
 */
const DEFAULT_NEARDUP_JACCARD = 0.85;

/**
 * Don't judge a hit as a near-dup unless it has at least this many distinct
 * words. Two short chunks (terse list items, one-line config) can share enough
 * boilerplate to clear a 0.85 Jaccard while being genuinely distinct documents;
 * the floor protects them from a false drop. A hit below the floor is always
 * kept.
 */
const MIN_DEDUP_TOKENS = 12;

interface NearDupPayload {
  content?: string;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

/** Jaccard similarity of two word sets. Empty-vs-anything is treated as 0 (an
 *  empty/contentless hit can't be judged a near-dup, so it is never dropped). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function dedupByTextSimilarity<T extends NearDupPayload>(
  hits: readonly ChunkScore<T>[],
  threshold: number = DEFAULT_NEARDUP_JACCARD,
): ChunkScore<T>[] {
  const kept: ChunkScore<T>[] = [];
  const keptSets: Set<string>[] = [];
  for (const h of hits) {
    const ws = wordSet(h.payload?.content ?? "");
    let dup = false;
    // Only judge hits with enough words; short hits are never dropped (the
    // floor) so a terse-but-distinct chunk can't be a false near-dup.
    if (ws.size >= MIN_DEDUP_TOKENS) {
      for (const ks of keptSets) {
        if (jaccard(ws, ks) > threshold) {
          dup = true;
          break;
        }
      }
    }
    if (!dup) {
      kept.push(h);
      keptSets.push(ws);
    }
  }
  return kept;
}

/**
 * Near-dup Jaccard threshold, memoized once per process (single source shared
 * by the ranking path AND the query-cache key, so they can't diverge). Env
 * `MEMRAIN_NEARDUP_JACCARD` overrides the 0.85 default; a value > 1.0 disables the
 * stage (no Jaccard can exceed it). Malformed → throw (fail-loud), matching the
 * other ranking-knob parsers.
 */
export class NearDupThresholdParseError extends Error {}

export function resolveNearDupThreshold(
  envValue: string | undefined = process.env["MEMRAIN_NEARDUP_JACCARD"],
): number {
  if (envValue === undefined || envValue.trim() === "") return DEFAULT_NEARDUP_JACCARD;
  const raw = envValue.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new NearDupThresholdParseError(
      `invalid MEMRAIN_NEARDUP_JACCARD: ${JSON.stringify(envValue)}`,
    );
  }
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new NearDupThresholdParseError(
      `invalid MEMRAIN_NEARDUP_JACCARD: ${JSON.stringify(envValue)}`,
    );
  }
  return v;
}

let _nearDupThreshold: number | null = null;
export function getNearDupThreshold(): number {
  return (_nearDupThreshold ??= resolveNearDupThreshold());
}

// ---------------------------------------------------------------------------
// Type-diversity layer: no page type may exceed
// MAX_TYPE_RATIO of the result set, so a corpus dominated by one shape (chat
// exports, daily notes) can't monopolise every slot. Greedy in rank order —
// the strongest hits of the over-represented type survive; the tail yields
// slots to other types. `maxRatio >= 1` disables the layer.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TYPE_RATIO = 0.6;

export class TypeRatioParseError extends Error {}

/** `MEMRAIN_MAX_TYPE_RATIO` override; >= 1 disables. Fail-loud on garbage. */
export function resolveMaxTypeRatio(
  envValue: string | undefined = process.env["MEMRAIN_MAX_TYPE_RATIO"],
): number {
  if (envValue === undefined || envValue.trim() === "") return DEFAULT_MAX_TYPE_RATIO;
  const raw = envValue.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new TypeRatioParseError(`invalid MEMRAIN_MAX_TYPE_RATIO: ${JSON.stringify(envValue)}`);
  }
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new TypeRatioParseError(`invalid MEMRAIN_MAX_TYPE_RATIO: ${JSON.stringify(envValue)}`);
  }
  return v;
}

let _maxTypeRatio: number | null = null;
export function getMaxTypeRatio(): number {
  return (_maxTypeRatio ??= resolveMaxTypeRatio());
}

interface TypedPayload {
  frontmatter?: unknown;
  sourcePath?: string;
}

/**
 * Derive a hit's page type: explicit `frontmatter.type` wins; otherwise the
 * first path segment of the (scheme-stripped) source path — `people/x` →
 * "people". Untyped, segment-less paths group under "note".
 */
export function pageTypeOf(payload: TypedPayload | undefined): string {
  const fm = payload?.frontmatter;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) {
    const t = (fm as Record<string, unknown>)["type"];
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  let path = payload?.sourcePath ?? "";
  if (path.startsWith("page-truth://")) path = path.slice("page-truth://".length);
  else if (path.startsWith("page://")) path = path.slice("page://".length);
  path = path.replace(/^\/+/, "");
  const slash = path.indexOf("/");
  if (slash > 0) return path.slice(0, slash);
  return "note";
}

/**
 * Enforce the type-diversity cap: keep at most `ceil(n × maxRatio)` hits per
 * page type (floor 1), in rank order. `maxRatio >= 1` returns the input as-is.
 *
 * A SINGLE-type candidate set passes through untouched — there is nothing to
 * diversify toward, so truncating it would only lose recall on uniform corpora.
 */
export function enforceTypeDiversity<T extends TypedPayload>(
  hits: readonly ChunkScore<T>[],
  maxRatio: number = getMaxTypeRatio(),
): ChunkScore<T>[] {
  if (!(maxRatio < 1) || hits.length === 0) return [...hits];
  const types = hits.map((h) => pageTypeOf(h.payload));
  if (new Set(types).size <= 1) return [...hits];
  const maxPerType = Math.max(1, Math.ceil(hits.length * maxRatio));
  const counts = new Map<string, number>();
  const kept: ChunkScore<T>[] = [];
  for (let i = 0; i < hits.length; i++) {
    const t = types[i]!;
    const c = counts.get(t) ?? 0;
    if (c < maxPerType) {
      kept.push(hits[i]!);
      counts.set(t, c + 1);
    }
  }
  return kept;
}
