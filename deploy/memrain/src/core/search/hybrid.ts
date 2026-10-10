/**
 * Hybrid search orchestrator — coordinates the pieces in core/search/*.
 *
 * Pipeline:
 *   1. classify intent (zero-LLM regex taxonomy; Haiku only via MEMRAIN_INTENT_LLM=1)
 *   2. (parallel) embed query → vector retrieval; keyword retrieval
 *      (both arms carry the curation prefix boost + default hard-excludes)
 *   3. (opt-in) query expansion → extra keyword passes
 *   3a. identifier arm (default ON): head chunk of every page the query NAMES
 *   4. RRF fuse all retrieval lists (per-list k/weight)
 *   5. hydrate top-(k * 3) chunks with parent doc + source kind
 *   6. boosts: compiled-truth ×2, source, recency (decay + temporal boost),
 *      salience (+ mattering join), curation, title, graph/backlink,
 *      exact-match, alias-resolved
 *   7. dedup per documentId (cap 2; skipped for `exact` intent) + type diversity
 *   8. (opt-in) two-pass Haiku rerank over the return window if MEMRAIN_RERANK=1
 *   9. trim to k
 *
 * The exported `hybridSearch(storage, query, k)` API stays compatible
 * with existing callers (commands/search.ts, mcp/dispatch.ts).
 * Internal rewiring only.
 */
import type { Storage } from "../storage.ts";
import { isOperationError } from "../operation-error.ts";
import type { SourceKind } from "../sources.ts";
import { embedText } from "../embedding.ts";
import { reciprocalRankFusion } from "../rrf.ts";
import { vectorSearch } from "./vector.ts";
import { keywordSearch, keywordSearchRelaxed, keywordSearchScored } from "./keyword.ts";
import { resolveDateBoundary } from "./filters.ts";
import { visibilityClause } from "../visibility.ts";
import { andSourceScope, isNoGrant } from "../source-scope.ts";
import {
  dedupByDocument,
  dedupByTextSimilarity,
  getNearDupThreshold,
  enforceTypeDiversity,
  type ChunkScore,
} from "./dedup.ts";
import {
  applySourceBoost,
  type BoostablePayload,
} from "./source-boost.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import {
  rrfWeightsForLists,
  exactMatchBoostForTaxonomy,
  exactMatchIndices,
} from "./intent-weights.ts";
import { classifyQuerySuggestions } from "./query-intent.ts";
import { activeModeBundle, resolveKnob, resolveSearchMode } from "./mode.ts";
import { recordSearchTelemetry } from "./telemetry.ts";
import {
  recencyMultiplierForPath,
  resolveRecencyDecayMap,
  resolveRecencyBoostMap,
  recencyBoostMultiplierForPath,
} from "./recency.ts";
import { chronicleBoostMultiplier } from "./chronicle-boost.ts";
import { salienceMultiplier, applyMatteringBoost } from "./salience.ts";
import { applyAliasResolvedBoost, ALIAS_RESOLVED_BOOST } from "./alias-resolved.ts";
import { slugCandidatesForPath } from "./page-slug.ts";
import { isTitlePhraseMatch, getTitleBoost } from "./title-match.ts";
import { isCanonicalQuery } from "./recency-gate.ts";
import {
  getSearchExcludePrefixes,
  isExcludedPath,
} from "./curation.ts";
import {
  resolveAdaptiveReturn,
  applyAdaptiveReturn,
  type AdaptiveReturnInput,
} from "./return-policy.ts";
import { applyTokenBudget } from "./token-budget.ts";
import {
  stampEvidence,
  stampDefaultEvidence,
  type Evidence,
  type CreateSafety,
} from "./evidence.ts";
import {
  getCachedQuery,
  getSemanticCachedQuery,
  putCachedQuery,
  queryCacheKey,
  queryCacheBucketKey,
  rankingSignature,
  resolveSemanticCacheConfig,
  type CachedQuery,
} from "./query-cache.ts";
import { stampContentFlags, type ContentFlag } from "./content-flag.ts";
import { currentDocumentClock } from "../generation.ts";
import type { Engine } from "../engine/interface.ts";
import { expandQuery } from "./expansion.ts";
import { rerank, type ChunkPayloadForRerank } from "./two-pass.ts";
import { graphRerank, graphRerankLiveEnabled } from "./graph-rerank.ts";
import {
  applyGraphSignals,
  computeFloorThreshold,
  getGraphSignalsFloorRatio,
} from "./graph-signals.ts";
import { applyAliasHop, aliasHopEnabled } from "./alias-hop.ts";
import { titleArmChunkIds, titleArmEnabled, TITLE_ARM_WEIGHT } from "./title-arm.ts";
import { expandAnchors } from "./structural-expand.ts";
import { applyBacklinkBoost } from "./backlink-boost.ts";
import { cosineReScore } from "./cosine-rescore.ts";
import type { ChunkFilters } from "./filters.ts";
import { relationalArmChunkIds } from "./relational-recall.ts";
import {
  snapshotScores,
  recordStageFactor,
  mergeExplain,
  finalizeExplain,
  type SearchExplain,
} from "./explain.ts";
import type { DegradedReason, SearchCacheState, SearchMeta } from "./search-meta.ts";
import { rankFlag } from "./ranking-flags.ts";
import { skipMetadataBoosts } from "./metadata-boost-gate.ts";
import { downweightKeywordArm, KEYWORD_WEAK_WEIGHT } from "./arm-confidence.ts";
import { fuseByPage, pageKeysForChunks } from "./page-fusion.ts";
import { promoteExactLookup } from "./exact-lookup.ts";
import { gradeConfidence } from "./confidence-grade.ts";

/**
 * RRF weight for the deterministic relational arm (opt-in 4th arm). A gentle
 * multiplier on par with the keyword arm — a typed-edge answer should compete,
 * not dominate. Env-overridable (MEMRAIN_RELATIONAL_ARM_WEIGHT); an invalid value
 * falls back to the default.
 */
function relationalArmWeight(): number {
  const n = Number(process.env.MEMRAIN_RELATIONAL_ARM_WEIGHT);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

// Two-pass rerank candidate window (`top_n_in`, default 30). The
// reranker sees this many top candidates and may promote one above the return
// cutoff; the actual return size (k) trims afterward. Clamped to >= k and to the
// available candidate count at the call site.
const DEFAULT_RERANK_WINDOW = 30;
function resolveRerankWindow(): number {
  const n = Number.parseInt(process.env.MEMRAIN_RERANK_WINDOW ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RERANK_WINDOW;
}

// Recency decay map resolved once per process (defaults ∪ MEMRAIN_RECENCY_DECAY).
// Memoized so the env parse + its fail-loud validation runs on the first
// search, not on every query.
let _recencyDecayMap: ReturnType<typeof resolveRecencyDecayMap> | null = null;
function getRecencyDecayMap(): ReturnType<typeof resolveRecencyDecayMap> {
  return (_recencyDecayMap ??= resolveRecencyDecayMap());
}

// Recency BOOST map (defaults ∪ MEMRAIN_RECENCY_BOOST) — same memoization
// contract as the decay map. Only consulted when the zero-LLM classifier
// suggests a temporal tilt (recency 'on'/'strong').
let _recencyBoostMap: ReturnType<typeof resolveRecencyBoostMap> | null = null;
function getRecencyBoostMap(): ReturnType<typeof resolveRecencyBoostMap> {
  return (_recencyBoostMap ??= resolveRecencyBoostMap());
}

/**
 * Compiled-truth boost: chunks of a page's compiled-truth mirror
 * (`page-truth://…`, see page-index.ts) are the canonical per-page answers,
 * multiplied ×2 after fusion — but ONLY at detail 'low' (one chunk per
 * document), where the distilled truth is exactly what the collapse should
 * keep. At the default detail the multiplier is NOT order-preserving across
 * pages: RRF-fused scores sit in a narrow band, so ×2 let a weakly-matching
 * page's mirror chunk displace a strongly-matching page's best chunk.
 * Also bypassed for temporal queries (detail 'high') — freshness queries
 * want the record, not the distilled truth.
 */
const COMPILED_TRUTH_BOOST = 2.0;
const PAGE_TRUTH_PREFIX = "page-truth://";

/**
 * The classifier reads every "tell me about X" as detail 'low', and at ×2 a
 * mirror that barely matches still outranks the page body that answers. With
 * MEMRAIN_RANK_ENTITY_TRUTH_SOFT the full ×2 needs the caller to ask for
 * detail 'low'; a classifier guess gets a tilt that only settles near-ties.
 */
const COMPILED_TRUTH_SOFT_BOOST = 1.2;

export function compiledTruthBoost(
  requestedDetail: SearchOptions["detail"],
  resolvedDetail: SearchOptions["detail"],
  soft: boolean,
): number {
  if (resolvedDetail !== "low") return 1;
  if (!soft || requestedDetail === "low") return COMPILED_TRUTH_BOOST;
  return COMPILED_TRUTH_SOFT_BOOST;
}

/** A strict keyword pass with fewer rows than this triggers the OR retry. */
const KEYWORD_RELAX_MIN_ROWS = 3;
/** RRF weight of the OR-retry rows: they matched some of the query, not all of it. */
const RELAXED_KEYWORD_WEIGHT = 0.5;

/** The resolved per-call ranking knob set (see {@link resolveSearchKnobs}). */
export interface ResolvedSearchKnobs {
  rerankWanted: boolean;
  graphRerankOn: boolean;
  expansionEnabled: boolean;
  graphSignalsOn: boolean;
  cosineRescoreOn: boolean;
  relationalArmOn: boolean;
  backlinkBoostOn: boolean;
  titleArmOn: boolean;
  tokenBudget: number | undefined;
}

/**
 * Resolve the ranking knobs for one search call — per-call opts win, then an
 * explicit per-knob env ("1"/"0"), then the active mode bundle
 * (MEMRAIN_SEARCH_MODE; the default `conservative` bundle equals memrain's
 * historical all-OFF defaults). Exported so tests and cache-key callers can
 * reproduce exactly what hybridSearch resolves.
 *
 * Expansion default OFF (the measured lift is negligible; each call is
 * a paid Haiku request). The hermetic `expandQueryFn` seam implies ON — a test
 * that injects an expander wants the expansion path exercised. `noExpansion`
 * is the hard veto either way.
 */
export function resolveSearchKnobs(opts: SearchOptions = {}): ResolvedSearchKnobs {
  const bundle = activeModeBundle();
  const env = process.env;
  return {
    rerankWanted: resolveKnob(opts.rerank, env.MEMRAIN_RERANK, bundle.rerank),
    // No mode bundle carries the graph rerank: it is paid Sonnet, so it stays
    // per-call/env opt-in.
    graphRerankOn: opts.graphRerank ?? graphRerankLiveEnabled(),
    expansionEnabled:
      !opts.noExpansion &&
      (opts.expansion ??
        (opts.expandQueryFn !== undefined ||
          resolveKnob(undefined, env.MEMRAIN_QUERY_EXPANSION, bundle.expansion))),
    graphSignalsOn: resolveKnob(opts.graphSignals, env.MEMRAIN_GRAPH_SIGNALS, bundle.graphSignals),
    cosineRescoreOn: resolveKnob(opts.cosineRescore, env.MEMRAIN_COSINE_RESCORE, bundle.cosineRescore),
    relationalArmOn: resolveKnob(opts.relationalArm, env.MEMRAIN_RELATIONAL_ARM, bundle.relationalArm),
    // Backlink boost keeps its default-ON contract in every mode.
    backlinkBoostOn: opts.backlinkBoost ?? env.MEMRAIN_BACKLINK_BOOST !== "0",
    // Identifier arm is default-ON in every mode, like the backlink boost: it
    // adds recall the other arms structurally cannot reach, never a re-weight.
    titleArmOn: opts.titleArm ?? titleArmEnabled(),
    tokenBudget: opts.tokenBudget ?? bundle.tokenBudget,
  };
}

/**
 * The per-call resolved-knob suffix appended to the env-level
 * rankingSignature() for the query-cache key — a caller flipping a knob per
 * call must never share a cached ordering with one that didn't.
 */
export function knobsCacheSuffix(kn: ResolvedSearchKnobs): string {
  return (
    `:RXP=${kn.expansionEnabled ? 1 : 0}:RGS=${kn.graphSignalsOn ? 1 : 0}` +
    `:RCR=${kn.cosineRescoreOn ? 1 : 0}:RBB=${kn.backlinkBoostOn ? 1 : 0}` +
    `:RTA=${kn.titleArmOn ? 1 : 0}` +
    // Appended only when ON: the graph rerank reorders the list that gets
    // stored, so an on/off pair must not share a key — but emitting a `=0`
    // component would re-key every default call and discard the live cache for
    // a knob almost nobody sets.
    (kn.graphRerankOn ? ":RGR=1" : "")
  );
}

// Title-boost factor: memoized in title-match.ts (single source shared with the
// query-cache ranking signature) so the key and the ranking can never diverge.

export interface SearchOptions {
  k?: number;
  embeddingModel?: string;
  /**
   * Optional query-embedder injection. Defaults to the real Titan embedder;
   * set ONLY by hermetic tests to drive the vector arm with deterministic
   * vectors (no Bedrock). Production never passes this.
   */
  embedQuery?: (text: string) => Promise<number[]>;
  rrfK?: number;
  /** Restrict to specific sources by id. */
  sourceIds?: readonly string[];
  /** Override MEMRAIN_RERANK. */
  rerank?: boolean;
  /**
   * Opt-in graph-aware Sonnet rerank (default OFF; falls back to
   * MEMRAIN_GRAPH_RERANK). POST-FUSION: reorders the top hits with one paid
   * Sonnet call, given each hit's excerpt + a link-graph connectivity hint.
   * Fail-open — any error/budget-skip returns the pre-rerank order. Distinct
   * from `rerank` (the Haiku two-pass text reranker). See graph-rerank.ts.
   */
  graphRerank?: boolean;
  /** Override the zero-LLM intent classification — for tests / callers that know. */
  intent?: Intent;
  /** Skip query expansion. */
  noExpansion?: boolean;
  /**
   * Force LLM query expansion on/off for this call. Default OFF (the measured
   * lift is negligible and each expansion is a paid Haiku call): resolution is
   * `expansion` → MEMRAIN_QUERY_EXPANSION ("1"/"0")
   * → the active mode bundle (only `tokenmax` turns it on). Passing
   * `expandQueryFn` (the hermetic test seam) implies ON unless `noExpansion`.
   */
  expansion?: boolean;
  /**
   * Optional query-expander injection. Defaults to the real Bedrock expander;
   * set ONLY by hermetic tests to drive the expansion pass with deterministic
   * synonyms (no Bedrock). Production never passes this.
   */
  expandQueryFn?: (query: string, opts: { max: number }) => Promise<string[]>;
  /** Disable the exact-match query cache for this call (default: enabled). */
  noCache?: boolean;
  /**
   * Optional cap on the total estimated tokens (chars/4) of returned
   * `content`, consumed in rank order. The first hit is always kept
   * (truncated if it alone exceeds the budget); the overflowing tail hit
   * is truncated and iteration stops. Unset = no cap.
   */
  tokenBudget?: number;
  /**
   * Opt-in adaptive return-sizing (default OFF): trim the returned list to an
   * intent-driven cap. `true` enables the defaults; a partial object overrides
   * the caps. Applied as the final view AFTER the query cache has stored the
   * full ranked set, so it never poisons a later adaptive-off lookup. See
   * return-policy.ts.
   */
  adaptiveReturn?: AdaptiveReturnInput;
  /**
   * Optional side-channel: invoked once after results are computed,
   * with the raw query + result IDs + latency + meta. Used by the
   * eval-capture wiring in dispatchers; never blocks user-visible
   * output (callback is awaited but errors are swallowed by the
   * caller).
   */
  onCapture?: (info: SearchCaptureInfo) => Promise<void> | void;
  /**
   * Optional side-channel: invoked once per call with how the search ran
   * (vector arm available, cache state, degraded reasons, pool and returned
   * counts). Purely observational — it never changes ranking, the cache key or
   * the returned hits, and a throwing callback is swallowed. See search-meta.ts.
   */
  onMeta?: (meta: SearchMeta) => void;
  /**
   * Opt-in graph-signals stage (default OFF): adjacency hub boost + session
   * diversification over the link graph. Falls back to MEMRAIN_GRAPH_SIGNALS=1.
   * The live ranking model is immutable unless this is set. See graph-signals.ts.
   */
  graphSignals?: boolean;
  /**
   * Backlink-count boost (default ON): multiply each hit by
   * 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL in-degree from the
   * `links` table, floor-ratio-gated like graph-signals. Deterministic + cheap
   * (one links tally). Falls back to MEMRAIN_BACKLINK_BOOST !== "0". Set false /
   * MEMRAIN_BACKLINK_BOOST=0 to disable. See backlink-boost.ts.
   */
  backlinkBoost?: boolean;
  /**
   * Identifier (title/slug) arm (default ON): fuse the head chunk of every page
   * whose title or slug leaf appears verbatim in the query as an extra RRF list.
   * Closes the recall gap where a page's name lives only in its title/path —
   * neither retrieval arm indexes those columns, so the post-fusion title and
   * exact-slug boosts had no candidate to act on. Falls back to
   * MEMRAIN_TITLE_ARM !== "0". See title-arm.ts.
   */
  titleArm?: boolean;
  /**
   * Cosine re-score blend (default OFF): before dedup, re-score each candidate
   * as 0.7*normalizedRRF + 0.3*(query·chunk cosine) so semantically-closer
   * chunks survive the per-doc collapse. Adds one embeddings fetch per query.
   * Falls back to MEMRAIN_COSINE_RESCORE === "1". Inert on the keyword-only
   * fallback (no query vector). See cosine-rescore.ts.
   */
  cosineRescore?: boolean;
  /** Filter to chunks of a given source language (chunks.language, e.g. "typescript"). */
  lang?: string;
  /** Filter to chunks of a given symbol kind (chunks.symbol_type, e.g. "function"). */
  symbolKind?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is >= this ISO date. */
  since?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is <= this ISO date. */
  until?: string;
  /**
   * Structural two-pass expansion (default OFF): walk the code call graph
   * `walkDepth` hops (1-2, capped at 2) from the fused anchors over
   * `code_edges_symbol`, scoring neighbors by `anchorScore * 1/(1+hop)`.
   * Code corpora only; inert when no edges exist. See structural-expand.ts.
   */
  walkDepth?: number;
  /**
   * Anchor retrieval at this qualified symbol name — its chunk(s) join the
   * fused anchor set, seeding the structural walk even when the text query
   * matched nothing. Bypasses the query cache like the per-call filters.
   */
  nearSymbol?: string;
  /**
   * Relational recall as a 4th RRF arm (opt-in, default OFF): parse the query
   * for a typed-edge intent ("who founded X", "where does Y work") and fuse the
   * deterministic edge fan-out's page head-chunks alongside keyword + vector, so
   * a relationship answer competes for ranking instead of relying on lexical /
   * vector overlap to surface it. Falls back to MEMRAIN_RELATIONAL_ARM=1. Bypasses
   * the query cache (the arm widens the candidate set). No-op for non-relational
   * queries. See relational-recall.ts.
   */
  relationalArm?: boolean;
  /**
   * Per-page max-pool (opt-in, default OFF): make each retrieval arm return its
   * best chunk per (source, document) so the fanout budget covers N distinct
   * pages, not N chunks that collapse to fewer pages downstream. Falls back to
   * MEMRAIN_MAXPOOL=1. Auto-disabled for `exact` intent and structural walks
   * (both deliberately want multiple chunks per page). See keyword/vector.ts.
   */
  maxPool?: boolean;
  /**
   * Per-signal ranking attribution (opt-in, default OFF): stamp each returned
   * hit with a `explain` record — the base RRF score plus the factor every boost
   * stage contributed (source/recency/salience/curation/title/backlink/graph)
   * and the reranker's rank delta. Zero cost when off. See explain.ts.
   */
  explain?: boolean;
  /**
   * Per-call detail override. Overrides the
   * zero-LLM classifier's suggestion: `high` gets the temporal treatment
   * (source-boost bypass) AND lifts the per-document chunk cap (all chunks);
   * `low` collapses to one chunk per document; `medium` keeps the default
   * cap. Bypasses the query cache (it changes the returned set).
   */
  detail?: "low" | "medium" | "high";
  /**
   * Per-call mattering-salience bias: overrides
   * BOTH the classifier suggestion and the canonical-query gate. `strong`
   * uses the aggressive mattering coefficient. Bypasses the query cache.
   */
  salience?: "off" | "on" | "strong";
  /**
   * Per-call recency-boost bias: overrides BOTH
   * the classifier suggestion and the canonical-query gate. Bypasses the
   * query cache.
   */
  recency?: "off" | "on" | "strong";
  /**
   * @internal Set by the zero-result broadened retry to stop recursion after a
   * single re-run. Callers never set this.
   */
  _zeroRetried?: boolean;
}

export interface SearchCaptureInfo {
  query: string;
  k: number;
  resultDocIds: string[];
  intent: Intent;
  latencyMs: number;
  rerank: boolean;
  expansion: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  title: string | null;
  content: string;
  score: number;
  intent: Intent;
  /** Set when `content` was cut to fit a `tokenBudget` (trailing "…"). */
  truncated?: boolean;
  /** Why this hit matched (arm-membership signal) — see evidence.ts. */
  evidence?: Evidence;
  /** Derived don't-duplicate hint for the agent — see evidence.ts. */
  create_safety?: CreateSafety;
  /**
   * WARN signal: the page carries a `content_flag` frontmatter marker
   * (markup-heavy / oversize / operator-flagged). Still searchable — this tells
   * the agent to examine the page before trusting it. Absent when clean.
   * Stamped post-fusion by `stampContentFlags`. See content-flag.ts.
   */
  content_flag?: ContentFlag;
  /**
   * Per-signal ranking attribution — present ONLY when the search ran with the
   * opt-in `explain` flag. See explain.ts / SearchOptions.explain.
   */
  explain?: SearchExplain;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

// Query-embed deadline. The vector arm must never let a slow/stuck Bedrock call
// hold the whole search hostage: the embed runs against a wall-clock budget, and
// on timeout we fall back to keyword-only (embedding failure is non-fatal).
const QUERY_EMBED_TIMEOUT_MS = (() => {
  const n = Number(process.env.MEMRAIN_QUERY_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6_000;
})();
const MIN_QUERY_EMBED_BUDGET_MS = 2_000;

export interface QueryEmbedDeadline {
  signal: AbortSignal;
  deadlineAt: number;
}

/**
 * The query embed ran past its wall-clock budget. Distinct from any other embed
 * failure so the search meta can say `embed_timeout` rather than
 * `vector_arm_failed`.
 */
export class QueryEmbedDeadlineError extends Error {
  override name = "QueryEmbedDeadlineError";
}

function isEmbedTimeout(e: unknown, dl: QueryEmbedDeadline): boolean {
  if (e instanceof QueryEmbedDeadlineError) return true;
  if (!dl.signal.aborted) return false;
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function reportMeta(opts: SearchOptions, meta: SearchMeta): void {
  if (!opts.onMeta) return;
  try {
    opts.onMeta(meta);
  } catch {
    // The meta channel is observational; a broken listener never fails a search.
  }
}

export function makeQueryEmbedDeadline(ms = QUERY_EMBED_TIMEOUT_MS): QueryEmbedDeadline {
  return { signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms };
}

/**
 * Embed a query under a wall-clock deadline. Threads the deadline's abort signal
 * into the Bedrock call AND races the promise against a fail-loud timer, so a
 * hung connection that ignores the abort still cannot block past the budget.
 * Returns the vector or throws on deadline; the caller treats a throw as a
 * keyword-only fallback.
 */
export async function embedQueryBounded(
  text: string,
  embedOpts: { embeddingModel?: string } | undefined,
  dl: QueryEmbedDeadline,
): Promise<number[]> {
  const p = embedText(text, {
    modelId: embedOpts?.embeddingModel ?? EMBED_MODEL,
    abortSignal: dl.signal,
    // One attempt gets a third of the budget, so a hung attempt ends early
    // enough for the SDK's retry to land inside the deadline; with the client's
    // own 10 s per attempt, no retry could ever help a search.
    requestTimeoutMs: Math.max(500, Math.floor(QUERY_EMBED_TIMEOUT_MS / 3)),
  });
  p.catch(() => {});
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new QueryEmbedDeadlineError(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      remaining,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Race an injected embedder (the hermetic `embedQuery` test seam) against the
 * same deadline as `embedQueryBounded`, so the bounded behaviour is identical
 * whether the embed comes from Bedrock or a test injection.
 */
async function raceEmbedderAgainstDeadline(
  embedFn: (text: string) => Promise<number[]>,
  text: string,
  dl: QueryEmbedDeadline,
): Promise<number[]> {
  const p = embedFn(text);
  p.catch(() => {});
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new QueryEmbedDeadlineError(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      remaining,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  /** Live-model content freshness (documents.updated_at), for recency. */
  updated_at?: string | null;
  /** Document frontmatter (documents.frontmatter), for salience. */
  frontmatter?: unknown;
  /** Chunk source language (chunks.language), for the lang filter. */
  language?: string | null;
  /** Chunk symbol kind (chunks.symbol_type), for the symbol_kind filter. */
  symbol_type?: string | null;
  /** Content date COALESCE(effective_date, updated_at), for since/until. */
  effective_date?: string | null;
}

/**
 * Hydrate a cached list of chunk ids back into SearchHits, preserving the
 * cached order. Chunks that no longer exist are silently skipped, so a
 * cache hit can never resurrect deleted content. Scores are synthetic
 * (descending by rank) — the ranking decision was already made at cache
 * write time.
 */
async function hydrateByIds(
  engine: Engine,
  ids: readonly string[],
  intent: Intent,
  sourceIds?: readonly string[],
): Promise<SearchHit[]> {
  if (ids.length === 0) return [];
  // Tenant scope (belt-and-suspenders): a cached result-id set can predate a
  // re-scope, so a scoped caller must re-filter on hydrate — the cache key
  // includes the scope, but a stale row keyed before the scope changed could
  // otherwise leak another source's chunk. No-op when unscoped.
  const params: unknown[] = [ids];
  const sourceFilter = andSourceScope("d.source_id", sourceIds, params);
  const rows = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
  }>(
    // Visibility filter here too (belt-and-suspenders): a cached query can
    // re-hydrate ids captured before a doc was soft-deleted/archived/
    // quarantined. The column-flip ops bump per-doc generation to invalidate
    // Layer-2, but filtering at hydrate guarantees a hidden doc never surfaces
    // even if an invalidation is ever missed.
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])
        AND ${visibilityClause("d")}${sourceFilter}`,
    params,
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const out: SearchHit[] = [];
  let score = ids.length;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      score--;
      continue;
    }
    out.push({
      chunkId: row.id,
      documentId: row.document_id,
      sourcePath: row.source_path,
      title: row.title,
      content: row.content,
      score: score--,
      intent,
    });
  }
  return out;
}

export async function hybridSearch(
  storage: Storage,
  query: string,
  optsOrK: SearchOptions | number = {},
): Promise<SearchHit[]> {
  const opts: SearchOptions =
    typeof optsOrK === "number" ? { k: optsOrK } : optsOrK;
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    throw new Error("hybridSearch: query must be non-empty");
  }
  // A caller granted no source reads nothing: return before the cache, any arm
  // or a paid embedding call can touch the brain.
  if (isNoGrant(opts.sourceIds)) {
    reportMeta(opts, {
      vectorEnabled: false,
      intent: opts.intent ?? "topic",
      mode: resolveSearchMode(),
      cache: "off",
      degraded: [],
      retrieved: 0,
      returned: 0,
    });
    return [];
  }
  const startedAt = Date.now();
  const k = opts.k ?? 10;
  const fanout = Math.max(20, k * 3);
  const engine = storage.engine();
  // Adaptive return-sizing (opt-in, default OFF). Resolved once; applied as the
  // final view on BOTH return paths, after the cache has stored the full set.
  const adaptiveCfg = resolveAdaptiveReturn(opts.adaptiveReturn);
  // Resolve the graph-signals floor ratio up-front (memoized, fail-loud) so a
  // malformed MEMRAIN_GRAPH_SIGNALS_FLOOR surfaces here rather than being
  // swallowed by the cache try-block below — which catches bare and would
  // silently disable caching on every query. rankingSignature() reads the same
  // memoized value inside that block.
  const graphFloorRatio = getGraphSignalsFloorRatio();

  // Zero-LLM query suggestions (query-intent.ts): one regex
  // pass drives the temporal source-boost bypass, the recency-boost strength,
  // the mattering-salience gate, and the exact-match boost magnitude.
  const suggestions = classifyQuerySuggestions(trimmed);
  // Agent-explicit detail wins over the classifier (the query op's
  // explicit detail/salience/recency params override the heuristic).
  const detailResolved = opts.detail ?? suggestions.suggestedDetail;
  const temporalQuery = detailResolved === "high";
  // Read per call so an eval run can flip one between queries; each is off by
  // default and every stage below is untouched while it stays off.
  const rank = {
    metadataGate: rankFlag("METADATA_GATE"),
    entityTruthSoft: rankFlag("ENTITY_TRUTH_SOFT"),
    keywordOrRetry: rankFlag("KEYWORD_OR_RETRY"),
    pageFusion: rankFlag("PAGE_FUSION"),
    keywordConfidence: rankFlag("KEYWORD_CONFIDENCE"),
    exactLookup: rankFlag("EXACT_LOOKUP"),
  };

  const {
    rerankWanted,
    graphRerankOn,
    expansionEnabled,
    graphSignalsOn,
    cosineRescoreOn,
    relationalArmOn,
    backlinkBoostOn,
    titleArmOn,
    tokenBudget,
  } = resolveSearchKnobs(opts);

  // 0. Exact-match query cache (fail-open). A hit skips intent + embed +
  //    retrieval + fusion entirely. Validity is gated on the live-model
  //    generation clock, so any document write invalidates it. Any cache
  //    error falls through to a normal search — the cache is pure
  //    optimization and must never break retrieval.
  // Per-call post-hydrate filters (lang / symbol_kind / since / until) are NOT
  // part of the cache key, so a filtered query bypasses the query cache
  // entirely — it never reads a cached unfiltered set nor writes a filtered one.
  const hasFilters = Boolean(
    opts.lang || opts.symbolKind || opts.since || opts.until,
  );
  // Pushed-down filter set (lang / symbol_kind / since / until). Threaded into
  // BOTH retrieval arms so the per-arm LIMIT budget is spent on already-matching
  // rows — a filtered match ranking below the fanout is no longer dropped. The
  // post-hydrate filter (step 5b) still runs as the choke point for structural
  // neighbors, which bypass the retrieval arms. Undefined when no axis is set.
  const chunkFilters: ChunkFilters | undefined = hasFilters
    ? {
        ...(opts.lang ? { lang: opts.lang } : {}),
        ...(opts.symbolKind ? { symbolKind: opts.symbolKind } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      }
    : undefined;
  // Structural expansion (near_symbol / walk_depth) widens the candidate set
  // beyond what the query alone produces, so its result must never be served
  // from — nor written to — the exact-match query cache.
  const structural = (opts.walkDepth ?? 0) > 0 || Boolean(opts.nearSymbol);
  // Relational recall (resolved above) widens the candidate set beyond what
  // the query alone produces, so its result must never be served from — nor
  // written to — the exact-match query cache.
  // Per-signal explain (opt-in). Its stamping never changes ranking, but a
  // cached hit re-hydrates ids without the per-stage factors, so an explain call
  // bypasses the cache to guarantee the attribution is always populated.
  const explainOn = opts.explain ?? false;
  // Per-page max-pool (opt-in) changes the retrieval ranking but is NOT part of
  // the query-cache key, so a max-pool call must bypass the cache rather than
  // read/write a ranking that a non-pooled call could share. Resolved from the
  // raw flag here (the intent/structural refinement below only ever narrows it).
  const maxPoolRequested = opts.maxPool ?? process.env.MEMRAIN_MAXPOOL === "1";
  // Per-call ranking overrides (detail / salience / recency) change the
  // returned set or its order but are NOT part of the cache key — bypass the
  // cache rather than share a ranking a default call could re-serve.
  const rankingOverrides = Boolean(opts.detail || opts.salience || opts.recency);
  const cacheEnabled =
    !opts.noCache &&
    !hasFilters &&
    !structural &&
    !relationalArmOn &&
    !explainOn &&
    !maxPoolRequested &&
    !rankingOverrides &&
    process.env.MEMRAIN_QUERY_CACHE !== "0";
  let cacheKey = "";
  let cacheClock = 0;
  let cacheReady = false;
  let cacheErrored = false;
  // Serve a cache hit (exact or semantic): re-hydrate from the live tables,
  // stamp the uniform evidence + content-flag contract, fire capture, and apply
  // the final adaptive-return view. Shared by both cache arms so they behave
  // identically. `expansion: false` is correct for both — a cache hit
  // short-circuits before the expansion/retrieval stage.
  const serveCachedRanking = async (cached: CachedQuery): Promise<SearchHit[]> => {
    const cachedIntent = (cached.intent as Intent) ?? "topic";
    const hydrated = await hydrateByIds(engine, cached.resultIds, cachedIntent, opts.sourceIds);
    const hits =
      tokenBudget !== undefined
        ? applyTokenBudget(hydrated, tokenBudget)
        : hydrated;
    // Cache hits have no arm membership to classify — stamp the conservative
    // default so the evidence contract is uniform (always present) and never a
    // false `exists`. A title-phrase match is still computable from the hit
    // title, so a cached title hit surfaces `exact_title_match` rather than a
    // flat `weak_semantic`.
    stampDefaultEvidence(hits, trimmed);
    // Same WARN channel on the cache-hit path so the flag is uniform.
    await stampContentFlags(engine, hits);
    if (opts.onCapture) {
      try {
        await opts.onCapture({
          query: trimmed,
          k,
          resultDocIds: hits.map((h) => h.documentId),
          intent: cachedIntent,
          latencyMs: Date.now() - startedAt,
          rerank: rerankWanted,
          expansion: false,
        });
      } catch {
        // capture failures never surface
      }
    }
    // Per-day rollup (migration 089) — sync bucket bump, flushed off the hot
    // path; fail-open by construction.
    recordSearchTelemetry(
      engine,
      { mode: resolveSearchMode(), intent: cachedIntent, cache: "hit" },
      hits,
      hydrated.length - hits.length,
    );
    // Adaptive return-sizing (opt-in, default OFF) — the FINAL view, applied
    // after the cache read served the full stored set and after capture saw it,
    // so the cap never poisons the cache or shrinks the eval window.
    const kept = applyAdaptiveReturn(hits, cachedIntent, adaptiveCfg).kept;
    // Only healthy rankings are ever cached (see 9a), so a hit is served with the
    // vector arm on and nothing degraded except what this call's budget cut.
    reportMeta(opts, {
      vectorEnabled: true,
      intent: cachedIntent,
      mode: resolveSearchMode(),
      cache: "hit",
      degraded: hydrated.length > hits.length ? ["budget_truncated"] : [],
      retrieved: hydrated.length,
      returned: kept.length,
      confidence: gradeConfidence(kept),
    });
    return kept;
  };
  // Ranking signature for the cache key: the env-level signature plus the
  // per-call RESOLVED knob values — a caller that
  // flips graph-signals/cosine/backlink/expansion per call must never share a
  // cached ordering with a caller that didn't.
  const rankingSig =
    rankingSignature() +
    knobsCacheSuffix({
      rerankWanted,
      graphRerankOn,
      expansionEnabled,
      graphSignalsOn,
      cosineRescoreOn,
      relationalArmOn,
      backlinkBoostOn,
      titleArmOn,
      tokenBudget,
    });
  if (cacheEnabled) {
    try {
      cacheClock = await currentDocumentClock(engine);
      cacheKey = queryCacheKey(trimmed, k, opts.sourceIds, rerankWanted, rankingSig);
      const cached = await getCachedQuery(engine, cacheKey, cacheClock);
      cacheReady = true;
      if (cached) return await serveCachedRanking(cached);
    } catch {
      cacheReady = false; // fall through to a normal search
      cacheErrored = true;
    }
  }
  // "miss" only when the cache was actually consulted; a read that threw never
  // looked, so reporting a miss would hide a broken cache behind normal traffic.
  const cacheState: SearchCacheState = !cacheEnabled ? "off" : cacheErrored ? "error" : "miss";

  // 1. Intent (cheap heuristic + Claude Haiku). Allow override for tests.
  const intent = opts.intent ?? (await classifyIntent(trimmed));

  // 2. Embed + parallel retrieval. Keyword needs the original query;
  //    expansion produces additional keyword passes. `embedQuery` is an
  //    optional injection seam: when set it replaces the Bedrock embedder,
  //    letting a hermetic test drive the vector arm with deterministic vectors.
  //    Unset (the only production path) → the real Titan embedder, unchanged.
  //    The embed runs under a wall-clock deadline: a slow/stuck Bedrock call
  //    must never hold the whole search hostage. On timeout (or any embed
  //    error) the vector arm is dropped and we fall back to keyword-only —
  //    embedding failure is non-fatal.
  let queryVector: number[] | null = null;
  const degraded: DegradedReason[] = [];
  const dl = makeQueryEmbedDeadline();
  try {
    queryVector = opts.embedQuery
      ? await raceEmbedderAgainstDeadline(opts.embedQuery, trimmed, dl)
      : await embedQueryBounded(trimmed, { embeddingModel: opts.embeddingModel }, dl);
  } catch (e) {
    // A budget refusal is the operator's policy, not a flaky embedder: degrade
    // quietly on any embed failure EXCEPT that one, which must reach the caller
    // instead of looking like an empty brain.
    if (isOperationError(e) && e.code === "budget_exhausted") throw e;
    queryVector = null; // keyword-only fallback
    degraded.push(isEmbedTimeout(e, dl) ? "embed_timeout" : "vector_arm_failed");
  }

  // 1b. Semantic query cache (opt-in, default OFF). On an exact-match miss, try
  //     the nearest stored query embedding within the same scope/knobs bucket,
  //     cosine >= threshold, TTL- and freshness-gated. Requires a healthy vector
  //     arm — a degraded/null `queryVector` skips this path (the degraded
  //     ranking must not be borrowed by a paraphrase). Fail-open like the exact
  //     arm: any error falls through to the full search.
  if (cacheReady && queryVector !== null) {
    const semCfg = resolveSemanticCacheConfig();
    if (semCfg.enabled) {
      try {
        const bucket = queryCacheBucketKey(k, opts.sourceIds, rerankWanted, rankingSig, detailResolved);
        const sem = await getSemanticCachedQuery(
          engine,
          bucket,
          queryVector,
          cacheClock,
          semCfg,
        );
        if (sem) return await serveCachedRanking(sem);
      } catch {
        // semantic cache is a pure optimization — fall through to full search
      }
    }
  }

  // Per-page max-pool (opt-in) — make each arm return its best chunk per page.
  // Auto-disabled for `exact` intent and structural walks, both of which
  // deliberately want multiple chunks per page (the collapse would fight them).
  const maxPoolOn = maxPoolRequested && intent !== "exact" && !structural;

  // Curation prefix boost inside the arm SQL: shapes which
  // rows survive the per-arm LIMIT. Bypassed for temporal queries — freshness
  // queries must not be steered toward evergreen curated tiers.
  const armSourceBoost = !temporalQuery;

  const [vectorIds, primaryKeywordRows] = await Promise.all([
    queryVector
      ? vectorSearch(engine, queryVector, fanout, {
          sourceIds: opts.sourceIds,
          filters: chunkFilters,
          maxPool: maxPoolOn,
          sourceBoost: armSourceBoost,
          onCandidatesIncomplete: () => degraded.push("vector_candidates_incomplete"),
        })
      : Promise.resolve<string[]>([]),
    keywordSearchScored(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
      filters: chunkFilters,
      maxPool: maxPoolOn,
      sourceBoost: armSourceBoost,
    }),
  ]);
  const primaryKeywordIds = primaryKeywordRows.map((r) => r.id);
  if (primaryKeywordIds.length === 0) degraded.push("keyword_zero");

  // 3. Expansion (default OFF — see SearchOptions.expansion; skipped for
  //    exact intent regardless).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  // Arm name per list, for the page-fusion vote attribution in explain.
  const listArms: string[] = ["vector", "keyword"];
  if (intent !== "exact" && expansionEnabled) {
    const variants = await (opts.expandQueryFn ?? expandQuery)(trimmed, { max: 3 });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordSearch(engine, v, fanout, {
            sourceIds: opts.sourceIds,
            filters: chunkFilters,
            maxPool: maxPoolOn,
            sourceBoost: armSourceBoost,
          }),
        ),
      );
      lists.push(...extra);
      listArms.push(...extra.map(() => "expansion"));
    }
  }

  // 4. RRF fuse — weighted by intent (base list order is [vector, keyword,
  //    ...keywordExpansions], so keyword lists = lists.length - 1). The optional
  //    relational arm is fused as an extra list with its own gentle weight.
  const rrfWeights = rrfWeightsForLists(intent, lists.length - 1);
  // 3a. Identifier arm (default ON) — the head chunk of every page the query
  //     NAMES (its title / slug leaf appears verbatim in the query). Built from
  //     the ORIGINAL query, never an expansion variant: a page's name is the
  //     user's own word for it. Empty for a query that names nothing, which is
  //     the common case — a pure no-op on the fused result.
  let titleIds: string[] = [];
  let titleListIdx = -1;
  if (titleArmOn) {
    titleIds = await titleArmChunkIds(engine, trimmed, {
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
      limit: fanout,
    });
    if (titleIds.length > 0) {
      titleListIdx = lists.length;
      lists.push(titleIds);
      listArms.push("title");
      rrfWeights.push(TITLE_ARM_WEIGHT);
    }
  }
  // 3b. Relational recall arm (opt-in, default OFF) — a deterministic 4th arm.
  //     Built from the ORIGINAL query (never an expansion variant); empty for
  //     non-relational queries → pure no-op. Fail-open inside the helper.
  let relationalIds: string[] = [];
  if (relationalArmOn) {
    relationalIds = await relationalArmChunkIds(storage, trimmed, {
      ...(opts.sourceIds ? { sourceIds: [...opts.sourceIds] } : {}),
      limit: fanout,
    });
    if (relationalIds.length > 0) {
      lists.push(relationalIds);
      listArms.push("relational");
      rrfWeights.push(relationalArmWeight());
    }
  }
  // 3c. OR retry (MEMRAIN_RANK_KEYWORD_OR_RETRY): plainto_tsquery is AND-only,
  //     so one stray word in the query empties the keyword arm. When the strict
  //     pass is thin, chunks matching ANY query lexeme fuse as their own
  //     low-weight list. They stay out of primaryKeywordIds, so they never earn
  //     keyword_exact evidence nor count as a lexical vote for the gate.
  //     Only while the vector arm returned nothing: next to a healthy vector
  //     arm, any-word matches out-vote the semantic answer to a paraphrase
  //     (the cross-lingual transcript in retrieval_quality_eval_misses drops
  //     out of the window), so the retry is a rescue, not an extra voice.
  if (
    rank.keywordOrRetry &&
    vectorIds.length === 0 &&
    primaryKeywordIds.length < KEYWORD_RELAX_MIN_ROWS
  ) {
    const strict = new Set(primaryKeywordIds);
    const relaxed = await keywordSearchRelaxed(engine, trimmed, fanout, {
      sourceIds: opts.sourceIds,
      filters: chunkFilters,
      maxPool: maxPoolOn,
      sourceBoost: armSourceBoost,
    });
    const relaxedIds = relaxed.map((r) => r.id).filter((id) => !strict.has(id));
    if (relaxedIds.length > 0) {
      lists.push(relaxedIds);
      listArms.push("keyword_relaxed");
      rrfWeights.push(RELAXED_KEYWORD_WEIGHT);
    }
  }
  // 3d. Keyword-arm confidence (MEMRAIN_RANK_KEYWORD_CONFIDENCE): a keyword
  //     arm that cannot separate its top two pages fuses at half weight, title
  //     arm included. See arm-confidence.ts.
  if (
    downweightKeywordArm({
      enabled: rank.keywordConfidence,
      keywordRows: primaryKeywordRows,
      vectorVoted: vectorIds.length > 0,
      relationalVoted: relationalIds.length > 0,
    })
  ) {
    rrfWeights[1] = rrfWeights[1]! * KEYWORD_WEAK_WEIGHT;
    if (titleListIdx >= 0) rrfWeights[titleListIdx] = rrfWeights[titleListIdx]! * KEYWORD_WEAK_WEIGHT;
  }
  // 4a. Page-grain fusion (MEMRAIN_RANK_PAGE_FUSION), see page-fusion.ts. One
  //     extra lookup maps every listed chunk to its page.
  const pageKeys = rank.pageFusion ? await pageKeysForChunks(engine, lists.flat()) : null;
  const pageFused = pageKeys
    ? fuseByPage(lists, { k: opts.rrfK, weights: rrfWeights, pageOf: (id) => pageKeys.get(id) })
    : null;
  const fused = (
    pageFused
      ? pageFused.map(({ id, score }) => ({ id, score }))
      : reciprocalRankFusion(lists, {
          k: opts.rrfK,
          weights: rrfWeights,
        })
  ).slice(0, fanout);

  // 4b. Structural two-pass expansion (near_symbol / walk_depth) — default OFF.
  //     Widen the candidate set with code-graph neighbors BEFORE hydrate so the
  //     neighbors flow through the single hydrate + scoring + dedup path. Runs
  //     before the empty-fused short-circuit so a bare `near_symbol` query (no
  //     keyword/vector hit) can still seed anchors. Best-effort: a missing or
  //     empty edge table must never break base retrieval.
  if (structural) {
    try {
      const expanded = await expandAnchors(
        engine,
        fused.map((f) => ({ id: f.id, score: f.score })),
        {
          walkDepth: opts.walkDepth,
          nearSymbol: opts.nearSymbol,
          sourceIds: opts.sourceIds,
        },
      );
      const have = new Set(fused.map((f) => f.id));
      for (const e of expanded) {
        if (!have.has(e.id)) {
          fused.push({ id: e.id, score: e.score });
          have.add(e.id);
        }
      }
    } catch (err) {
      // Structural expansion is optional — fall back to the un-expanded anchors.
      // Log server-side so a real bug in the walk isn't masked as "no neighbors".
      console.warn(`[structural-expand] expansion failed, falling back: ${String(err)}`);
    }
  }

  if (fused.length === 0) {
    // Zero-result broadened retry (once). The only lever that can turn an empty
    // set non-empty is query expansion (different terms) — a bigger fanout can't
    // add rows that don't exist. So when an `exact`-intent pass found nothing and
    // expansion was permitted (the caller didn't opt out), re-run as `topic`,
    // which re-enables the synonym expansion pass. Gated OFF for filtered /
    // structural queries (an empty filtered set is correct semantics) and when
    // expansion is disabled (default OFF / `noExpansion` — a topic re-run
    // without the synonym pass would fuse the same empty lists), and capped at
    // one retry via `_zeroRetried`.
    const canBroaden =
      !opts._zeroRetried &&
      !hasFilters &&
      !structural &&
      expansionEnabled &&
      intent === "exact";
    if (canBroaden) {
      return await hybridSearch(storage, query, {
        ...opts,
        intent: "topic",
        noCache: true,
        _zeroRetried: true,
      });
    }
    reportMeta(opts, {
      vectorEnabled: queryVector !== null,
      intent,
      mode: resolveSearchMode(),
      cache: cacheState,
      degraded,
      retrieved: 0,
      returned: 0,
      confidence: gradeConfidence([]),
    });
    return [];
  }

  // 5. Hydrate.
  const ids = fused.map((f) => f.id);
  // Tenant scope: a scoped caller sees only its own sources. The retrieval arms
  // already filter by source, but the structural walk can surface neighbors
  // reached through the (source-agnostic) code edge table, so the hydrate join
  // re-asserts the scope as the single choke point. No-op when unscoped.
  const hydrateParams: unknown[] = [ids];
  const hydrateSourceFilter = andSourceScope("d.source_id", opts.sourceIds, hydrateParams);
  const rows = await engine.query<{
    id: string;
    document_id: string;
    content: string;
    source_path: string;
    title: string | null;
    source_id: string | null;
    source_kind: SourceKind | null;
    updated_at: string | null;
    frontmatter: unknown;
    language: string | null;
    symbol_type: string | null;
    effective_date: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind,
            d.updated_at::text AS updated_at,
            d.frontmatter,
            c.language,
            c.symbol_type,
            COALESCE(d.effective_date, d.updated_at)::text AS effective_date
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = d.source_id
     WHERE c.id = ANY($1::text[])
       AND ${visibilityClause("d")}${hydrateSourceFilter}`,
    hydrateParams,
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  let scored: ChunkScore<HitPayload>[] = [];
  for (const f of fused) {
    const row = byId.get(f.id);
    if (!row) continue;
    scored.push({
      chunkId: row.id,
      documentId: row.document_id,
      score: f.score,
      payload: {
        content: row.content,
        title: row.title,
        sourcePath: row.source_path,
        source_id: row.source_id,
        source_kind: row.source_kind,
        updated_at: row.updated_at,
        frontmatter: row.frontmatter,
        language: row.language,
        symbol_type: row.symbol_type,
        effective_date: row.effective_date,
      },
    });
  }

  // 5b. Per-call filters (lang / symbol_kind / since / until). Post-hydrate so
  //     they compose with fusion; the candidate set may shrink below k (filter
  //     semantics — only matching hits are returned). Cache is bypassed when
  //     any filter is set, so this never persists a filtered set.
  if (hasFilters) {
    // Compare dates as epoch ms, NOT strings: Postgres renders TIMESTAMPTZ as
    // "2024-03-15 10:00:00+00" (space separator) while a caller passes ISO
    // ("2024-03-15T…") — a raw string compare would mis-order across that gap.
    const sinceMs = opts.since ? Date.parse(resolveDateBoundary(opts.since, "since")) : NaN;
    const untilMs = opts.until ? Date.parse(resolveDateBoundary(opts.until, "until")) : NaN;
    scored = scored.filter((s) => {
      const p = s.payload;
      if (opts.lang && p?.language !== opts.lang) return false;
      if (opts.symbolKind && p?.symbol_type !== opts.symbolKind) return false;
      if (opts.since || opts.until) {
        const cd = p?.effective_date ?? p?.updated_at ?? null;
        const cdMs = cd ? Date.parse(cd) : NaN;
        if (Number.isNaN(cdMs)) return false;
        if (!Number.isNaN(sinceMs) && cdMs < sinceMs) return false;
        if (!Number.isNaN(untilMs) && cdMs > untilMs) return false;
      }
      return true;
    });
  }

  // 5c. Cosine re-score blend (opt-in, default OFF) — re-score each candidate as
  //     0.7*normalizedRRF + 0.3*(query·chunk cosine) BEFORE the multiplicative
  //     boosts + dedup, so a semantically-closer chunk survives the per-doc
  //     collapse. Runs only when the vector arm produced a query vector (nothing
  //     to blend on the keyword-only fallback). Fail-open: a fetch error leaves
  //     the RRF scores intact.
  if (cosineRescoreOn && queryVector !== null) {
    await cosineReScore(scored, engine, queryVector, opts.sourceIds);
  }

  // 6-. Hard-exclude — drop fixtures / attachments / raw sidecars by slug
  //     prefix (default test/, attachments/, .raw/; MEMRAIN_SEARCH_EXCLUDE overrides). Cheap precision
  //     filter, applied before scoring so excluded hits never compete.
  const excludePrefixes = getSearchExcludePrefixes();
  if (excludePrefixes.length > 0) {
    scored = scored.filter((s) => !isExcludedPath(s.payload?.sourcePath ?? null, excludePrefixes));
  }

  // Per-signal explain (opt-in) — accumulate each stage's factor keyed by
  // chunkId. The base is the fused RRF (+cosine) score captured here, right
  // before the first multiplicative boost. Only allocated/snapshotted when the
  // flag is on, so a normal search pays nothing.
  const explainAcc = explainOn ? new Map<string, Partial<SearchExplain>>() : null;
  if (explainAcc) for (const s of scored) explainAcc.set(s.chunkId, { base: s.score });
  if (explainAcc && pageFused) {
    const votesById = new Map(pageFused.map((r) => [r.id, r.votes] as const));
    for (const s of scored) {
      const votes = votesById.get(s.chunkId);
      if (!votes) continue;
      mergeExplain(explainAcc, s.chunkId, {
        arms: votes.map((v) => ({ arm: listArms[v.list] ?? `list${v.list}`, rank: v.rank })),
      });
    }
  }

  // Metadata-boost gate (MEMRAIN_RANK_METADATA_GATE): on a query only the
  // vector arm answered, the metadata stages below stand down and the
  // similarity order stands. See metadata-boost-gate.ts.
  const skipMetadata = skipMetadataBoosts({
    enabled: rank.metadataGate,
    vectorVoted: vectorIds.length > 0,
    lexicalVoted: primaryKeywordIds.length > 0 || titleIds.length > 0 || relationalIds.length > 0,
  });

  // 5d. Compiled-truth boost — a page's canonical answers (its compiled-truth
  //     mirror chunks) get ×2 so the distilled truth outranks body prose for
  //     the same page. Applied ONLY at detail=low (see COMPILED_TRUTH_BOOST):
  //     at medium/high the cross-page displacement outweighs the tilt.
  //     Pre-dedup like every other boost, so the truth chunk wins the
  //     per-doc collapse of its own mirror document.
  const truthBoost = compiledTruthBoost(opts.detail, detailResolved, rank.entityTruthSoft);
  if (truthBoost > 1) {
    for (const s of scored) {
      if (s.payload?.sourcePath?.startsWith(PAGE_TRUTH_PREFIX)) {
        s.score *= truthBoost;
        if (explainAcc) {
          mergeExplain(explainAcc, s.chunkId, { compiled_truth: truthBoost });
        }
      }
    }
  }

  // 6. Source-boost.
  const preSourceBoost = explainAcc ? snapshotScores(scored) : null;
  scored = applySourceBoost(scored);
  if (explainAcc && preSourceBoost) {
    recordStageFactor(explainAcc, preSourceBoost, scored, "source");
  }

  // 6b. Recency (documents.effective_date) + salience (frontmatter pinned/weight)
  //     — gentle post-fusion multipliers on the LIVE model. Immutable like
  //     the rest of the pipeline; both are neutral (1.0) when their signal
  //     is absent, so neither can bury a hit that doesn't declare it.
  const nowMs = Date.now();
  // Canonical/definitional queries ("who is X", "define X", a bare symbol)
  // want the authoritative page regardless of age — skip the recency + salience
  // multipliers for them (an explicit temporal bound re-enables freshness).
  const canonical = isCanonicalQuery(trimmed);
  // Curation authority by slug prefix — curated originals outrank bulk feeds
  // inside one store. Orthogonal to recency decay; neutral (×1) off-prefix.
  // Per-prefix recency decay (env-overridable); paths matching no prefix
  // (e.g. code chunks under `src/`) fall back to the original uniform decay.
  // Memoized: resolved once per process, so the env parse (and its fail-loud
  // validation) runs on the first search rather than on every query.
  const recencyMap = getRecencyDecayMap();
  // Title-phrase boost: when the query is a contiguous phrase in the page
  // title, nudge the score up by a scale-invariant factor. A name-of-thing
  // query should surface the page over a weak body chunk. Neutral (×1) for
  // every hit whose title doesn't match, so it can never bury a non-matching
  // hit; inert entirely when MEMRAIN_TITLE_BOOST <= 1.0.
  const titleBoost = getTitleBoost();
  const titleBoostActive = Number.isFinite(titleBoost) && titleBoost > 1.0;
  // Recency BOOST activation: the zero-LLM classifier's
  // off/on/strong suggestion. 'off' keeps the historical penalty-only decay;
  // 'on'/'strong' additionally LIFT fresh content hyperbolically so a
  // this-week note can win a "what's going on" query. Canonical queries stay
  // fully recency-neutral (both decay and boost skipped).
  // An explicit per-call recency bias overrides both the classifier and the
  // canonical gate (the agent asserted the temporal intent).
  const recencyBoostMode =
    opts.recency ?? (canonical ? "off" : suggestions.suggestedRecency);
  const recencyBoostMap = recencyBoostMode === "off" ? null : getRecencyBoostMap();
  scored = scored.map((s) => {
    const contentDate = s.payload?.effective_date ?? s.payload?.updated_at ?? null;
    const decayF = canonical || skipMetadata
      ? 1
      : recencyMultiplierForPath(
          // Decay on the content date (effective_date, already COALESCE'd with
          // updated_at at hydrate), NOT the row's updated_at — a backfill /
          // re-ingest / rechunk bumps updated_at and would otherwise make stale
          // content score as fresh.
          contentDate,
          nowMs,
          s.payload?.sourcePath ?? null,
          recencyMap,
        );
    const boostF = recencyBoostMap && !skipMetadata
      ? recencyBoostMultiplierForPath(
          contentDate,
          nowMs,
          s.payload?.sourcePath ?? null,
          recencyBoostMode as "on" | "strong",
          recencyBoostMap,
        )
      : 1;
    const recencyF = decayF * boostF;
    const salienceF = canonical || skipMetadata ? 1 : salienceMultiplier(s.payload?.frontmatter);
    // Curation tiers act ONLY inside the arm SQL (the
    // prefix factor shapes per-arm LIMIT survival; runPostFusionStages has no
    // curation stage). Multiplying the fused score again would double-apply
    // the tier map and over-tilt low-tier prefixes like chat/ 0.5.
    const titleF =
      titleBoostActive && isTitlePhraseMatch(trimmed, s.payload?.title) ? titleBoost : 1;
    // Life-Chronicle lift for life/events + life/diary hits — gated on the same
    // recency-boost activation, so a non-temporal query leaves every hit at ×1
    // (bit-for-bit unchanged). Pure ranking; the diary read-fence lives elsewhere.
    const chronicleF = skipMetadata
      ? 1
      : chronicleBoostMultiplier(
          s.payload?.sourcePath,
          recencyBoostMode as "off" | "on" | "strong",
        );
    if (explainAcc) {
      const patch: Partial<SearchExplain> = {};
      if (recencyF !== 1) patch.recency = recencyF;
      if (salienceF !== 1) patch.salience = salienceF;
      if (titleF !== 1) patch.title = titleF;
      if (chronicleF !== 1) patch.chronicle = chronicleF;
      mergeExplain(explainAcc, s.chunkId, patch);
    }
    return { ...s, score: s.score * recencyF * salienceF * titleF * chronicleF };
  });

  // 6b2. Mattering-salience join — the cycle-computed
  //      pages.salience score (emotional-weight tags + link degree + takes)
  //      lifts "what matters" pages when the query asks for current context
  //      (meeting prep / catch-up phrasings). Classifier-gated; canonical
  //      queries never fire it. Fail-open; floor-gated like the other
  //      metadata boosts.
  // Explicit per-call salience bias wins over classifier + canonical gate;
  // 'strong' selects the aggressive mattering coefficient.
  const matteringOn =
    opts.salience !== undefined
      ? opts.salience !== "off"
      : !canonical && suggestions.suggestedSalience === "on";
  if (matteringOn && !skipMetadata) {
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preMattering = explainAcc ? snapshotScores(scored) : null;
    try {
      await applyMatteringBoost(scored, engine, {
        strength: opts.salience === "strong" ? "strong" : "on",
        ...(Number.isFinite(floor) ? { floorThreshold: floor } : {}),
      });
    } catch {
      // A pages lookup error leaves scores intact.
    }
    if (explainAcc && preMattering) {
      recordStageFactor(explainAcc, preMattering, scored, "mattering");
    }
  }

  // 6c. Graph signals (opt-in, default OFF) — adjacency hub boost + session
  //     diversification over the link graph, applied pre-dedup on the full
  //     scored set so a hub's chunk can rise before per-doc collapse. Mutates
  //     score in place; fail-open (a links query error leaves scores intact).
  if (graphSignalsOn && !skipMetadata) {
    // Relative score floor (MEMRAIN_GRAPH_SIGNALS_FLOOR): a hit must score within
    // `ratio` of the top hit to be eligible for a graph signal. Unset → the
    // ratio is undefined → computeFloorThreshold returns -Infinity; collapse
    // that back to `undefined` so the disabled path is byte-identical to the
    // pre-floor call (the `floor === undefined` short-circuit), with no NaN-edge
    // divergence between the two.
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preGraph = explainAcc ? snapshotScores(scored) : null;
    await applyGraphSignals(scored, engine, {
      enabled: true,
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
    if (explainAcc && preGraph) recordStageFactor(explainAcc, preGraph, scored, "graph");
  }

  // 6d. Backlink-count boost (default ON) — a standing hub signal: multiply each
  //     hit by 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL
  //     in-degree from the `links` table. Distinct from graph-signals (which
  //     counts only in-set links, opt-in): this reads whole-corpus in-degree so
  //     a hub earns a small boost on every query. Floor-ratio-gated by the SAME
  //     MEMRAIN_GRAPH_SIGNALS_FLOOR ratio (undefined → no gate, every hit
  //     eligible). Pre-dedup so the boost decides which chunk survives per-doc
  //     collapse; fail-open on a links query error.
  if (backlinkBoostOn && !skipMetadata) {
    const floor = computeFloorThreshold(scored, graphFloorRatio);
    const preBacklink = explainAcc ? snapshotScores(scored) : null;
    await applyBacklinkBoost(scored, engine, {
      floorThreshold: Number.isFinite(floor) ? floor : undefined,
      ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    });
    if (explainAcc && preBacklink) recordStageFactor(explainAcc, preBacklink, scored, "backlink");
  }

  // 6e. Exact-match boost — a hit whose slug / kebab-slug /
  //     title IS the query wins the tie on entity/event queries (the user
  //     typed the thing's name). Lexical-relevance signal: NOT floor-gated,
  //     applied outside the metadata gate.
  const exactBoost = exactMatchBoostForTaxonomy(suggestions.taxonomy);
  if (exactBoost > 1.0) {
    const cands = scored.map((s) => ({
      slugs: slugCandidatesForPath(s.payload?.sourcePath ?? null, s.payload?.source_id ?? null),
      title: s.payload?.title ?? null,
    }));
    for (const i of exactMatchIndices(cands, trimmed)) {
      const s = scored[i]!;
      s.score *= exactBoost;
      if (explainAcc) mergeExplain(explainAcc, s.chunkId, { exact: exactBoost });
    }
  }

  // 6f. Alias-resolved canonical boost (×1.05) — pages that
  //     old slugs forward to (slug_aliases canonical side) are the explicitly
  //     disambiguated authority. Fail-open: a pre-migration store no-ops.
  if (!skipMetadata) {
    try {
      const touched = await applyAliasResolvedBoost(scored, engine);
      if (explainAcc) {
        for (const i of touched) {
          mergeExplain(explainAcc, scored[i]!.chunkId, { alias: ALIAS_RESOLVED_BOOST });
        }
      }
    } catch {
      // Non-fatal — the boost is a nudge, never a dependency.
    }
  }

  // Re-sort after boost + recency (RRF was already sorted but these flip).
  scored.sort((a, b) => b.score - a.score);

  // 7. Per-document dedup — cap 2 chunks per document (maxPerPage 2; one
  //    strong page may show its two best chunks, the rest yield slots to other
  //    pages). Skip for `exact` intent ("show me
  //    everything about this note").
  // Structural walks deliberately surface multiple neighbor chunks from the
  // same document/class (sibling methods, the call-site + its callee), so the
  // one-chunk-per-doc collapse is widened proportionally to the walk depth.
  const maxPerDoc = structural
    ? Math.min(10, Math.max((opts.walkDepth ?? 0) * 5, 5))
    : opts.detail === "low"
      ? 1
      : 2;
  // detail 'high' = the all-chunks view: skip the per-doc collapse
  // entirely (like `exact` intent), so every matching chunk of a page returns.
  const perDoc =
    intent === "exact" || opts.detail === "high"
      ? scored
      : dedupByDocument(scored, {
          enabled: true,
          maxPerDoc,
          // Under page fusion a page and its compiled-truth mirror share one cap.
          ...(pageKeys ? { keyOf: (h) => pageKeys.get(h.chunkId) ?? `doc:${h.documentId}` } : {}),
        });

  // 7b. Type-diversity layer: no page type may exceed
  //     MEMRAIN_MAX_TYPE_RATIO (default 0.6) of the candidate set, so one noisy
  //     shape (chat exports, dailies) can't monopolise every slot. Skipped for
  //     `exact` intent and structural walks (both deliberately homogeneous).
  const diversified =
    intent === "exact" || structural || opts.detail === "high"
      ? perDoc
      : enforceTypeDiversity(perDoc);

  // 8. Two-pass rerank (opt-in) — runs BEFORE near-dup so the reranker sees
  //    both near-identical twins and decides their order; near-dup then drops
  //    the now-lower-ranked one (the reranker can't undo a drop, so it must
  //    come first). Contract: rerank a CANDIDATE window WIDER than the
  //    return size (top_n_in, default 30 via MEMRAIN_RERANK_WINDOW) so a hit fused
  //    below the return cutoff can still be promoted into the top-k — the trim
  //    to k happens after. The un-reranked tail keeps its fused order behind the
  //    window instead of being truncated away (it still feeds near-dup /
  //    alias-hop recall). The window is clamped to at least k and to the
  //    available candidate count.
  const rerankWindow = Math.min(
    diversified.length,
    Math.max(k, resolveRerankWindow()),
  );
  const preRerankOrder =
    explainAcc && rerankWanted
      ? new Map(diversified.map((h, i) => [h.chunkId, i] as const))
      : null;
  const reranked = rerankWanted
    ? [
        ...(await rerank(trimmed, diversified.slice(0, rerankWindow))),
        ...diversified.slice(rerankWindow),
      ]
    : diversified;
  if (explainAcc && preRerankOrder) {
    reranked.forEach((h, i) => {
      const prev = preRerankOrder.get(h.chunkId);
      if (prev !== undefined && prev !== i) {
        mergeExplain(explainAcc, h.chunkId, { rerank_delta: prev - i });
      }
    });
  }

  // 8b. Near-dup dedup across documents (Jaccard on text) — two DIFFERENT docs
  //     can still carry near-identical text (a note + its `.bak`); drop the
  //     lower-ranked twin. Applied AFTER rerank, skipped for `exact` intent or
  //     when MEMRAIN_NEARDUP_JACCARD > 1.0.
  let final = reranked;
  if (intent !== "exact") {
    const ndThreshold = getNearDupThreshold();
    if (ndThreshold <= 1.0) final = dedupByTextSimilarity(reranked, ndThreshold);
  }
  // 8b2. Exact lookup (MEMRAIN_RANK_EXACT_LOOKUP): the one page the whole query
  //      names goes to rank 1. See exact-lookup.ts.
  if (rank.exactLookup) final = promoteExactLookup(final, trimmed);

  // 8c. Alias-hop (default ON, exact-full-query-alias gated): if the whole
  //     query is a declared alias, boost the canonical page when present or
  //     inject it at the head when absent. Runs on the FULL post-rerank list
  //     (before the trim) so an injected page can't be trimmed out. A normal
  //     (non-alias) query is a no-op.
  let organic: SearchHit[] = final.map((h) => ({
    chunkId: h.chunkId,
    documentId: h.documentId,
    sourcePath: h.payload?.sourcePath ?? "",
    title: h.payload?.title ?? null,
    content: h.payload?.content ?? "",
    score: h.score,
    intent,
  }));
  if (aliasHopEnabled()) {
    organic = await applyAliasHop(organic, storage, trimmed, intent, opts.sourceIds);
  }

  // 8d. Graph-aware Sonnet rerank (opt-in, default OFF) — reorder the top hits
  //     with one paid Sonnet call using a link-graph connectivity hint. Runs on
  //     the FULL post-alias list (before the trim) so a promoted hit can't be
  //     trimmed out. Self-gates (returns input unchanged unless the flag/seam is
  //     set); fail-open on any error or budget skip. Distinct from the Haiku
  //     two-pass rerank above.
  if (graphRerankOn) {
    organic = await graphRerank(trimmed, organic, {
      storage,
      ...(opts.sourceIds ? { sourceIds: [...opts.sourceIds] } : {}),
    });
  }

  // 9. Trim to k (the ranked result, pre-token-budget).
  const ranked: SearchHit[] = organic.slice(0, k);

  // 9·explain — stamp per-signal attribution on the FINAL ranked hits (opt-in).
  //     Uses each hit's returned score as `final`; a hit with no accumulated
  //     factors (e.g. an alias-injected page that skipped the boost stages)
  //     finalizes to base=final with no boost lines. Pure-additive; no reorder.
  if (explainAcc) {
    for (let i = 0; i < ranked.length; i++) {
      const h = ranked[i]!;
      ranked[i] = { ...h, explain: finalizeExplain(explainAcc.get(h.chunkId), h.score) };
    }
  }

  // 9·evidence — stamp WHY each hit matched (which retrieval arm(s) surfaced
  //     it) + a conservative create_safety hint for the agent. Pure-additive:
  //     it does NOT reorder. (The cache-hit short-circuit stamps the
  //     conservative default earlier, so the contract is uniform.)
  //     The arm sets are the PRIMARY (un-expanded) vector + keyword passes by
  //     design: `keyword_exact` means the original query terms matched, not an
  //     LLM expansion paraphrase. Do NOT widen these to the expansion keyword
  //     lists — that would loosen the `exists` gate on paraphrase-only hits.
  //     A hit surfaced only by an expansion pass classifies weak_semantic
  //     (conservative, never a false `exists`).
  stampEvidence(ranked, new Set(vectorIds), new Set(primaryKeywordIds), trimmed);

  // 9·content_flag — stamp the WARN marker on any flagged page (best-effort,
  //     post-fusion). Pure-additive; never reorders or breaks search.
  await stampContentFlags(engine, ranked);

  // 9a. Populate the query cache (fire-and-forget) with the ranked chunk
  //     ids at the clock value read on entry. A clock that advanced mid-
  //     search makes this write immediately stale (never read) — harmless.
  //     Skip the write when the embed deadline dropped the vector arm
  //     (`queryVector === null`): that result is keyword-only/degraded, and the
  //     cache key has no vector-availability component, so caching it would pin
  //     the degraded ranking for the whole cache window even after Bedrock
  //     recovers. Recompute next time instead. The same holds for any other
  //     degraded run (keyword_zero): a hit replays no degraded list, so only a
  //     clean ranking may be stored.
  if (cacheReady && queryVector !== null && degraded.length === 0) {
    // Semantic arm (migration 065, opt-in): stamp the bucket key + query
    // embedding so a later paraphrase can match this row by cosine. Only when
    // the arm is on — the default path writes no extra vector per search.
    const semCfg = resolveSemanticCacheConfig();
    const semantic = semCfg.enabled
      ? {
          bucketKey: queryCacheBucketKey(k, opts.sourceIds, rerankWanted, rankingSig, detailResolved),
          queryEmbedding: queryVector,
        }
      : undefined;
    void putCachedQuery(
      engine,
      cacheKey,
      trimmed,
      k,
      intent,
      ranked.map((h) => h.chunkId),
      cacheClock,
      // Distinct documents the result chunks belong to → the Layer 2
      // per-document generation snapshot (migration 031). A later write to a
      // doc NOT in this set leaves the cached row servable.
      [...new Set(ranked.map((h) => h.documentId))],
      semantic,
    ).catch(() => {});
  }

  // 9b. Token budget (opt-in / mode-resolved) — cap total returned context size.
  let hits: SearchHit[] = ranked;
  if (tokenBudget !== undefined) {
    hits = applyTokenBudget(hits, tokenBudget);
    if (hits.length < ranked.length) degraded.push("budget_truncated");
  }

  // 10. Side-channel: optional capture hook for eval-capture wiring.
  // Errors here never affect the user-visible result — wrapped in a
  // try/catch so a failed INSERT can't poison search.
  if (opts.onCapture) {
    try {
      await opts.onCapture({
        query: trimmed,
        k,
        resultDocIds: hits.map((h) => h.documentId),
        intent,
        latencyMs: Date.now() - startedAt,
        rerank: rerankWanted,
        expansion: intent !== "exact" && expansionEnabled,
      });
    } catch {
      // Capture failures must not surface; classifier in eval-capture
      // already categorises them for the caller's logging.
    }
  }

  // 10b. Per-day telemetry rollup (migration 089) — sync bucket bump, flushed
  //      off the hot path; "miss" only when the cache was in play this call.
  recordSearchTelemetry(
    engine,
    { mode: resolveSearchMode(), intent, cache: cacheState },
    hits,
    ranked.length - hits.length,
  );

  // 11. Adaptive return-sizing (opt-in, default OFF) — the FINAL step. Applied
  //     after the cache write (9a stored the full `ranked` set) AND after the
  //     eval-capture hook (which records the full returned candidate set), so
  //     the cap is a pure view on the returned value: it never poisons the
  //     cache and never shrinks the eval window. Default OFF → `hits` unchanged.
  const kept = applyAdaptiveReturn(hits, intent, adaptiveCfg).kept;
  reportMeta(opts, {
    vectorEnabled: queryVector !== null,
    intent,
    mode: resolveSearchMode(),
    cache: cacheState,
    degraded,
    retrieved: fused.length,
    returned: kept.length,
    confidence: gradeConfidence(kept),
  });
  return kept;
}
