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
 *   7. dedup per page (cap 2 across a page's mirror, truth mirror and file
 *      twin; skipped for `exact` intent) + type diversity
 *   8. (opt-in) two-pass Haiku rerank over the return window if MEMRAIN_RERANK=1
 *   8e. relative time in the query lifts in-range hits into the first k
 *   8f. keyword-only: pages holding some of the words fill the empty slots
 *   9. trim to k
 *
 * The exported `hybridSearch(storage, query, k)` API stays compatible
 * with existing callers (commands/search.ts, mcp/dispatch.ts).
 * Internal rewiring only.
 */
import { hitProvenance, type SearchProvenance } from "./hit-provenance.ts";
import { withSearchSlot } from "../pool-budget.ts";
import type { Storage } from "../storage.ts";
import { isOperationError } from "../operation-error.ts";
import type { SourceKind } from "../sources.ts";
import { embedText } from "../embedding.ts";
import { reciprocalRankFusion } from "../rrf.ts";
import { isStatementTimeoutError } from "../retry.ts";
import { DEGRADED_REASONS } from "./search-meta.ts";
import { vectorSearch } from "./vector.ts";
import { keywordSearch, keywordSearchRelaxed, keywordSearchScored, keywordIdentifierSearch } from "./keyword.ts";
import { resolveDateBoundary, pageFilterClauses, validatePageFilters } from "./filters.ts";
import { visibilityClause } from "../visibility.ts";
import { searchDiagnostics } from "./diagnostics.ts";
import { andSourceScope, isNoGrant } from "../source-scope.ts";
import { meetsMinTrust, type TrustTier } from "../trust-tier.ts";
import { readTrustTiers } from "../trust-frame.ts";
import type { ChunkScore } from "./dedup.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import { keywordOnlyMode } from "../llm/gateway.ts";
import { rrfWeightsForLists } from "./intent-weights.ts";
import { classifyQuerySuggestions } from "./query-intent.ts";
import { activeModeBundle, resolveKnob, resolveSearchMode } from "./mode.ts";
import { recordSearchTelemetry } from "./telemetry.ts";
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
import { feedbackCacheSuffix } from "./feedback-boost.ts";
import { stampContentFlags, type ContentFlag } from "./content-flag.ts";
import { currentDocumentClock } from "../generation.ts";
import type { Engine } from "../engine/interface.ts";
import { expandQuery } from "./expansion.ts";
import { graphRerank, graphRerankLiveEnabled } from "./graph-rerank.ts";
import { getGraphSignalsFloorRatio } from "./graph-signals.ts";
import { applyAliasHop, aliasHopEnabled } from "./alias-hop.ts";
import { titleArmChunkIds, titleArmEnabled, TITLE_ARM_WEIGHT } from "./title-arm.ts";
import { expandAnchors } from "./structural-expand.ts";
import { cosineReScore } from "./cosine-rescore.ts";
import type { ChunkFilters } from "./filters.ts";
import { relationalArmChunkIds } from "./relational-recall.ts";
import {
  mergeExplain,
  finalizeExplain,
  type SearchExplain,
} from "./explain.ts";
import type { DegradedReason, SearchCacheState, SearchMeta } from "./search-meta.ts";
import { rankFlag } from "./ranking-flags.ts";
import { downweightKeywordArm, KEYWORD_WEAK_WEIGHT } from "./arm-confidence.ts";
import { fuseByPage, pageKeyFor, pageKeysForChunks } from "./page-fusion.ts";
import { applyTimeScope, dayInRange, parseQueryTimeRange } from "./time-range.ts";
import { dayInZone, pageContentDate, thinkTimeZone } from "../synthesis/think-temporal.ts";
import { CACHE_HIT_CONFIDENCE, gradeConfidence } from "./confidence-grade.ts";
import { paidStageEnabled, runPostFusionStages } from "./stages/pipeline.ts";
import { shadowCopy, shadowFlag, startShadow } from "./shadow.ts";
import type { Hit as HitScore, HitPayload, StageInput } from "./stages/types.ts";

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

// Moved with the rest of the post-fusion stages; re-exported for callers.
export { compiledTruthBoost } from "./stages/pipeline.ts";

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
  /** Leave this call out of the per-day search telemetry rollup. */
  noTelemetry?: boolean;
  /**
   * Caller cancellation. Once it fires the query embed is skipped or aborted
   * and the search goes on keyword-only, so an abandoned request stops paying.
   */
  signal?: AbortSignal;
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
  diagnostics?: boolean;
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
  types?: readonly string[];
  slugPrefix?: string;
  lang?: string;
  /** Filter to chunks of a given symbol kind (chunks.symbol_type, e.g. "function"). */
  symbolKind?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is >= this ISO date. */
  since?: string;
  /** Keep only docs whose content date COALESCE(effective_date,updated_at) is <= this ISO date. */
  until?: string;
  /** Drop chunks whose effective trust tier is below this one (core/trust-tier.ts). Unset reads every tier. */
  minTrust?: TrustTier;
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

export interface SearchHit extends Partial<SearchProvenance> {
  /** Read-side provenance label; never changes stored content or ranking. */
  trust?: "external";
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
    opts.onMeta({ ...meta, degraded: DEGRADED_REASONS.filter(reason => meta.degraded.includes(reason)) });
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
    // enough for the wallet's retry to land inside the deadline; with the client's
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
    source_id: string | null;
    effective_date: string | null;
    updated_at: string | null;
  }>(
    // Visibility filter here too (belt-and-suspenders): a cached query can
    // re-hydrate ids captured before a doc was soft-deleted/archived/
    // quarantined. The column-flip ops bump per-doc generation to invalidate
    // Layer-2, but filtering at hydrate guarantees a hidden doc never surfaces
    // even if an invalidation is ever missed.
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title, d.source_id,
            d.effective_date::text AS effective_date, d.updated_at::text AS updated_at
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
      ...hitProvenance(row),
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

const pageOfHit = (h: SearchHit): string => pageKeyFor(h.sourcePath, h.source_id ?? null, h.documentId);

/**
 * Pages holding some of the query's words (keywordSearchRelaxed: rare words
 * first), for the slots a keyword-only result left empty. One chunk per page,
 * pages already in `held` skipped, at most `room` rows, each scored below the
 * lowest held row so the fill always sorts after it. Scope, visibility, the
 * pushed-down filters and the hard-excludes apply as on any keyword row; the
 * trust floor is enforced over the whole result by hybridSearch.
 */
async function anyWordFill(
  engine: Engine,
  query: string,
  held: readonly SearchHit[],
  room: number,
  intent: Intent,
  opts: { fanout: number; sourceIds?: readonly string[]; filters?: ChunkFilters; sourceBoost: boolean },
): Promise<SearchHit[]> {
  const rows = await keywordSearchRelaxed(engine, query, opts.fanout, {
    sourceIds: opts.sourceIds,
    filters: opts.filters,
    maxPool: true,
    sourceBoost: opts.sourceBoost,
  });
  const heldChunks = new Set(held.map((h) => h.chunkId));
  const ids = rows.map((r) => r.id).filter((id) => !heldChunks.has(id));
  if (ids.length === 0) return [];
  const hydrated = await hydrateByIds(engine, ids, intent, opts.sourceIds);
  const excludePrefixes = getSearchExcludePrefixes();
  const pages = new Set(held.map(pageOfHit));
  const picked: SearchHit[] = [];
  for (const h of hydrated) {
    if (picked.length >= room) break;
    if (excludePrefixes.length > 0 && isExcludedPath(h.sourcePath, excludePrefixes)) continue;
    const page = pageOfHit(h);
    if (pages.has(page)) continue;
    pages.add(page);
    picked.push(h);
  }
  const floor = held.reduce((m, h) => (Number.isFinite(h.score) && h.score > 0 && h.score < m ? h.score : m), Infinity);
  const top = Number.isFinite(floor) ? floor : 1;
  return picked.map((h, i) => ({ ...h, score: (top * 0.5) / (i + 1) }));
}

/** Bounded by MEMRAIN_SEARCH_MAX_CONCURRENT when set (core/pool-budget.ts). */
export function hybridSearch(
  storage: Storage,
  query: string,
  optsOrK: SearchOptions | number = {},
): Promise<SearchHit[]> {
  return withSearchSlot(async () => {
    const hits = await hybridSearchUnbounded(storage, query, optsOrK);
    const minTrust = typeof optsOrK === "number" ? undefined : optsOrK.minTrust;
    return minTrust === undefined ? hits : enforceMinTrust(storage, hits, minTrust, optsOrK as SearchOptions);
  });
}

/**
 * The arms push the floor down so it does not starve the LIMIT; this pass is
 * the choke point for every path that adds hits after them (structural walk,
 * alias hop, cache-free fallbacks).
 */
async function enforceMinTrust(storage: Storage, hits: SearchHit[], minTrust: TrustTier, opts: SearchOptions): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  const tiers = await readTrustTiers(storage.engine(), { chunks: hits.map(h => h.chunkId) }, opts.sourceIds);
  return hits.filter(h => {
    const tier = tiers.chunks.get(h.chunkId);
    return tier !== undefined && meetsMinTrust(tier, minTrust);
  });
}

async function hybridSearchUnbounded(
  storage: Storage,
  query: string,
  optsOrK: SearchOptions | number,
): Promise<SearchHit[]> {
  const opts: SearchOptions =
    typeof optsOrK === "number" ? { k: optsOrK } : optsOrK;
  const diagnostic = opts.diagnostics ? searchDiagnostics(storage, opts.sourceIds, opts) : undefined;
  const report = async (meta: SearchMeta) => reportMeta(opts, { ...meta, ...(diagnostic ? await diagnostic.finish() : {}) });
  opts.signal?.throwIfAborted();
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    throw new Error("hybridSearch: query must be non-empty");
  }
  // A caller granted no source reads nothing: return before the cache, any arm
  // or a paid embedding call can touch the brain.
  if (isNoGrant(opts.sourceIds)) {
    await report({
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
  validatePageFilters(opts);
  const hasFilters = Boolean(
    opts.lang || opts.symbolKind || opts.since || opts.until || opts.types?.length || opts.slugPrefix || opts.minTrust,
  );
  // Relative time in the query ("last month", "gestern") resolves to a day range
  // that lifts hits dated inside it (step 8e). The caller's explicit
  // since/until win over it. The range moves with the calendar day while the
  // cache key does not, so a call that parsed one bypasses the query cache.
  const timeZone = thinkTimeZone();
  const timeRange = opts.since || opts.until ? null : parseQueryTimeRange(trimmed, dayInZone(new Date(), timeZone));
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
        ...(opts.types?.length ? { types: opts.types } : {}),
        ...(opts.slugPrefix ? { slugPrefix: opts.slugPrefix } : {}),
        ...(opts.minTrust ? { minTrust: opts.minTrust } : {}),
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
    !timeRange &&
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
    opts.signal?.throwIfAborted();
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
    opts.signal?.throwIfAborted();
    if (opts.onCapture) {
      try {
        void Promise.resolve(opts.onCapture({
          query: trimmed,
          k,
          resultDocIds: hits.map((h) => h.documentId),
          intent: cachedIntent,
          latencyMs: Date.now() - startedAt,
          rerank: rerankWanted,
          expansion: false,
        })).catch(() => {});
      } catch {
        // capture failures never surface
      }
    }
    // Per-day rollup (migration 089) — sync bucket bump, flushed off the hot
    // path; fail-open by construction.
    if (!opts.noTelemetry) {
      recordSearchTelemetry(
        engine,
        { mode: resolveSearchMode(), intent: cachedIntent, cache: "hit" },
        hits,
        hydrated.length - hits.length,
      );
    }
    // Adaptive return-sizing (opt-in, default OFF) — the FINAL view, applied
    // after the cache read served the full stored set and after capture saw it,
    // so the cap never poisons the cache or shrinks the eval window.
    const kept = applyAdaptiveReturn(hits, cachedIntent, adaptiveCfg).kept;
    // Only healthy rankings are ever cached (see 9a), so a hit is served with the
    // vector arm on and nothing degraded except what this call's budget cut.
    await report({
      vectorEnabled: true,
      intent: cachedIntent,
      mode: resolveSearchMode(),
      cache: "hit",
      degraded: hydrated.length > hits.length ? ["budget_truncated"] : [],
      retrieved: hydrated.length,
      returned: kept.length,
      confidence: { ...CACHE_HIT_CONFIDENCE },
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
    }) +
    (cacheEnabled ? await feedbackCacheSuffix(engine) : "");
  if (cacheEnabled) {
    try {
      cacheClock = await currentDocumentClock(engine);
      cacheKey = queryCacheKey(trimmed, k, opts.sourceIds, rerankWanted, rankingSig);
      const cached = await getCachedQuery(engine, cacheKey, cacheClock);
      cacheReady = true;
      if (cached) return await serveCachedRanking(cached);
    } catch {
      opts.signal?.throwIfAborted();
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
  const failArm = (error: unknown, arm: "keyword" | "vector" | "title" | "expansion" | "identifier" | "fill"): void => {
    opts.signal?.throwIfAborted();
    if (isOperationError(error) && error.code === "budget_exhausted") throw error;
    const reason = arm === "identifier" || arm === "fill" ? "keyword_candidates_incomplete" : arm === "keyword"
      ? isStatementTimeoutError(error) ? "keyword_timeout" : "keyword_arm_failed"
      : arm === "expansion" ? "expansion_failed" : `${arm}_arm_failed` as DegradedReason;
    degraded.push(reason);
  };
  const keywordArm = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try { return await run(); }
    catch (error) { failArm(error, "keyword"); return []; }
  };
  opts.signal?.throwIfAborted();
  // Per-page max-pool (opt-in) — make each arm return its best chunk per page.
  // Auto-disabled for `exact` intent and structural walks, both of which
  // deliberately want multiple chunks per page (the collapse would fight them).
  const maxPoolOn = maxPoolRequested && intent !== "exact" && !structural;

  // Curation prefix boost inside the arm SQL: shapes which
  // rows survive the per-arm LIMIT. Bypassed for temporal queries — freshness
  // queries must not be steered toward evergreen curated tiers.
  const armSourceBoost = !temporalQuery;

  // Settle eagerly: no arm rejection is left unobserved while embedding runs.
  diagnostic?.mark("prepare_cache");
  const lexical = Promise.allSettled([
    (async () => {
      const keywordOpts = { sourceIds: opts.sourceIds, filters: chunkFilters, maxPool: maxPoolOn, sourceBoost: armSourceBoost };
      const primary = await keywordArm(() => keywordSearchScored(engine, trimmed, fanout, keywordOpts));
      const probe = await keywordIdentifierSearch(engine, trimmed, fanout, keywordOpts)
        .catch(error => { failArm(error, "identifier"); return []; });
      const primaryIds = new Set(primary.map(row => row.id));
      return [...primary, ...probe.filter(row => !primaryIds.has(row.id))];
    })(),
    titleArmOn ? titleArmChunkIds(engine, trimmed, {
      onError: error => failArm(error, "title"), sourceIds: opts.sourceIds, limit: fanout, filters: chunkFilters,
    }) : Promise.resolve<string[]>([]),
    relationalArmOn ? relationalArmChunkIds(storage, trimmed, {
      ...(opts.sourceIds !== undefined ? { sourceIds: [...opts.sourceIds] } : {}), limit: fanout, filters: chunkFilters,
    }) : Promise.resolve<string[]>([]),
  ]);
  const deadline = makeQueryEmbedDeadline();
  const dl = opts.signal
    ? { ...deadline, signal: AbortSignal.any([deadline.signal, opts.signal]) }
    : deadline;
  try {
    opts.signal?.throwIfAborted();
    // Keyword-only mode has no vector arm to degrade: `vectorEnabled: false` says so.
    queryVector = keywordOnlyMode() ? null : opts.embedQuery
      ? await raceEmbedderAgainstDeadline(opts.embedQuery, trimmed, dl)
      : await embedQueryBounded(trimmed, { embeddingModel: opts.embeddingModel }, dl);
  } catch (e) {
    // A budget refusal is the operator's policy, not a flaky embedder: degrade
    // quietly on any embed failure EXCEPT that one, which must reach the caller
    // instead of looking like an empty brain.
    if ((isOperationError(e) && e.code === "budget_exhausted") || opts.signal?.aborted) {
      await lexical;
      throw e;
    }
    queryVector = null; // keyword-only fallback
    degraded.push(isEmbedTimeout(e, deadline) ? "embed_timeout" : "vector_arm_failed");
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
        if (sem) {
          await lexical;
          opts.signal?.throwIfAborted();
          return await serveCachedRanking(sem);
        }
      } catch {
        opts.signal?.throwIfAborted();
        // semantic cache is a pure optimization — fall through to full search
      }
    }
  }

  const [vectorResult, lexicalResult] = await Promise.allSettled([
    queryVector
      ? vectorSearch(engine, queryVector, fanout, {
          sourceIds: opts.sourceIds,
          filters: chunkFilters,
          maxPool: maxPoolOn,
          sourceBoost: armSourceBoost,
          onCandidatesIncomplete: () => degraded.push("vector_candidates_incomplete"),
        }).catch(error => { failArm(error, "vector"); queryVector = null; return []; })
      : Promise.resolve<string[]>([]),
    lexical,
  ]);
  opts.signal?.throwIfAborted();
  if (vectorResult.status === "rejected") throw vectorResult.reason;
  if (lexicalResult.status === "rejected") throw lexicalResult.reason;
  const [keywordResult, titleResult, relationalResult] = lexicalResult.value;
  if (keywordResult.status === "rejected") throw keywordResult.reason;
  if (titleResult.status === "rejected") throw titleResult.reason;
  if (relationalResult.status === "rejected") throw relationalResult.reason;
  const vectorIds = vectorResult.value;
  const primaryKeywordRows = keywordResult.value;
  const titleIds = titleResult.value;
  const relationalIds = relationalResult.value;
  const primaryKeywordIds = primaryKeywordRows.map((r) => r.id);
  if (primaryKeywordIds.length === 0 && !degraded.some(r => r === "keyword_timeout" || r === "keyword_arm_failed" || r === "keyword_candidates_incomplete")) degraded.push("keyword_zero");

  // 3. Expansion (default OFF — see SearchOptions.expansion; skipped for
  //    exact intent regardless).
  const lists: string[][] = [vectorIds, primaryKeywordIds];
  // Arm name per list, for the page-fusion vote attribution in explain.
  const listArms: string[] = ["vector", "keyword"];
  if (intent !== "exact" && expansionEnabled) {
    const variants = await (opts.expandQueryFn ?? expandQuery)(trimmed, { max: 3 })
      .catch(error => { failArm(error, "expansion"); return []; });
    if (variants.length > 0) {
      const extra = await Promise.all(
        variants.map((v) =>
          keywordArm(() => keywordSearch(engine, v, fanout, {
            sourceIds: opts.sourceIds,
            filters: chunkFilters,
            maxPool: maxPoolOn,
            sourceBoost: armSourceBoost,
          })),
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
  let titleListIdx = -1;
  if (titleArmOn) {
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
  if (relationalArmOn) {
    if (relationalIds.length > 0) {
      lists.push(relationalIds);
      listArms.push("relational");
      rrfWeights.push(relationalArmWeight());
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

  diagnostic?.mark("retrieval");
  // Any-word fill (step 8f): with no vector arm, plainto_tsquery is AND-only,
  // so one stray word empties the keyword arm. Pages holding some of the words
  // then fill the slots the strict rows left, below them. Not after a lexical
  // arm failed: more keyword statements against a failing database or a query
  // it cannot handle only fail again, and the empty result says so already.
  const lexicalFailed = degraded.some((r) =>
    r === "keyword_timeout" || r === "keyword_arm_failed" || r === "keyword_candidates_incomplete" || r === "title_arm_failed");
  const anyWordFillOn = vectorIds.length === 0 && !structural && !lexicalFailed;
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
    if (!anyWordFillOn) {
      await report({
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
  }

  // 5. Hydrate.
  const ids = fused.map((f) => f.id);
  // Tenant scope: a scoped caller sees only its own sources. The retrieval arms
  // already filter by source, but the structural walk can surface neighbors
  // reached through the (source-agnostic) code edge table, so the hydrate join
  // re-asserts the scope as the single choke point. No-op when unscoped.
  const hydrateParams: unknown[] = [ids];
  const hydrateSourceFilter = andSourceScope("d.source_id", opts.sourceIds, hydrateParams);
  const hydratePageFilter = pageFilterClauses(hydrateParams, chunkFilters);
  // Nothing fused (a keyword-only search the any-word fill may still answer): no statement.
  const rows = ids.length === 0 ? { rows: [] } : await engine.query<{
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
    effective_date_source: string | null;
  }>(
    `SELECT c.id, c.document_id, c.content,
            d.source_path, d.title,
            d.source_id,
            s.kind AS source_kind,
            d.updated_at::text AS updated_at,
            d.frontmatter,
            c.language,
            c.symbol_type,
            d.effective_date::text AS effective_date,
            d.effective_date_source
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = d.source_id
     WHERE c.id = ANY($1::text[])
       AND ${visibilityClause("d")}${hydrateSourceFilter}${hydratePageFilter}`,
    hydrateParams,
  );
  opts.signal?.throwIfAborted();
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
        effective_date: row.effective_date ?? row.updated_at,
        effective_date_source: row.effective_date_source,
        provenance: hitProvenance(row),
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

  // 5d–8b2. The post-fusion stages (stages/pipeline.ts): compiled-truth,
  //     source, recency/salience/title/chronicle, mattering, graph signals,
  //     backlinks, exact match, alias-resolved, re-sort, per-document cap, type
  //     diversity, the opt-in two-pass rerank, near-dup drop and exact lookup.
  const stageInput: StageInput = {
    engine,
    query: trimmed,
    intent,
    opts,
    detailResolved,
    suggestions,
    rank,
    k,
    structural,
    graphFloorRatio,
    graphSignalsOn,
    backlinkBoostOn,
    rerankWanted,
    votes: {
      vectorVoted: vectorIds.length > 0,
      lexicalVoted: primaryKeywordIds.length > 0 || titleIds.length > 0 || relationalIds.length > 0,
    },
    explainAcc,
  };
  // Shadow ranking (MEMRAIN_RANK_SHADOW, off by default): keep a copy of the
  // candidates before the stages score them in place, rank it with the flag
  // flipped once this call's result is decided, and record only aggregates.
  const wanted = shadowFlag();
  const shadow = wanted && !opts.noTelemetry && !graphRerankOn && !paidStageEnabled(stageInput) ? wanted : null;
  const shadowHits = shadow ? shadowCopy(scored) : null;
  const final = await runPostFusionStages(scored, stageInput);

  // 8c. Alias-hop (default ON, exact-full-query-alias gated): if the whole
  //     query is a declared alias, boost the canonical page when present or
  //     inject it at the head when absent. Runs on the FULL post-rerank list
  //     (before the trim) so an injected page can't be trimmed out. A normal
  //     (non-alias) query is a no-op.
  opts.signal?.throwIfAborted();
  const withAliasHop = async (hits: readonly HitScore[]): Promise<SearchHit[]> => {
    const mapped: SearchHit[] = hits.map((h) => ({
      ...h.payload?.provenance,
      chunkId: h.chunkId,
      documentId: h.documentId,
      sourcePath: h.payload?.sourcePath ?? "",
      title: h.payload?.title ?? null,
      content: h.payload?.content ?? "",
      score: h.score,
      intent,
    }));
    return aliasHopEnabled()
      ? applyAliasHop(mapped, storage, trimmed, intent, opts.sourceIds, { filters: chunkFilters })
      : mapped;
  };
  let organic: SearchHit[] = await withAliasHop(final);

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

  // 8e. Relative-time scope (time-range.ts): the top half of the first k stays,
  //     the other slots go to hits whose content date (never a row timestamp)
  //     falls in the query's range. A permutation: nothing is dropped.
  // 8f. Any-word fill: appended after every ranked row, never between them.
  const contentDays = timeRange
    ? new Map(final.map((h) => [h.chunkId, pageContentDate(h.payload?.effective_date, h.payload?.effective_date_source, timeZone)] as const))
    : null;
  const finishOrganic = async (list: SearchHit[]): Promise<SearchHit[]> => {
    let out = timeRange && contentDays
      ? applyTimeScope(list, k, (h) => dayInRange(contentDays.get(h.chunkId), timeRange))
      : list;
    if (anyWordFillOn && out.length < k) {
      try {
        out = [...out, ...(await anyWordFill(engine, trimmed, out, k - out.length, intent, {
          fanout,
          sourceIds: opts.sourceIds,
          filters: chunkFilters,
          sourceBoost: armSourceBoost,
        }))];
      } catch (error) {
        failArm(error, "fill");
      }
    }
    return out;
  };
  organic = await finishOrganic(organic);

  // 9. Trim to k (the ranked result, pre-token-budget).
  opts.signal?.throwIfAborted();
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
  opts.signal?.throwIfAborted();

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
  // Do not wait for capture I/O; both synchronous throws and rejections are
  // observational and must not delay or poison the search result.
  if (opts.onCapture) {
    try {
      void Promise.resolve(opts.onCapture({
        query: trimmed,
        k,
        resultDocIds: hits.map((h) => h.documentId),
        intent,
        latencyMs: Date.now() - startedAt,
        rerank: rerankWanted,
        expansion: intent !== "exact" && expansionEnabled,
      })).catch(() => {});
    } catch {
      // Capture failures must not surface; classifier in eval-capture
      // already categorises them for the caller's logging.
    }
  }

  // 10b. Per-day telemetry rollup (migration 089) — sync bucket bump, flushed
  //      off the hot path; "miss" only when the cache was in play this call.
  if (!opts.noTelemetry) {
    recordSearchTelemetry(
      engine,
      { mode: resolveSearchMode(), intent, cache: cacheState },
      hits,
      ranked.length - hits.length,
    );
  }

  // 11. Adaptive return-sizing (opt-in, default OFF) — the FINAL step. Applied
  //     after the cache write (9a stored the full `ranked` set) AND after the
  //     eval-capture hook (which records the full returned candidate set), so
  //     the cap is a pure view on the returned value: it never poisons the
  //     cache and never shrinks the eval window. Default OFF → `hits` unchanged.
  const kept = applyAdaptiveReturn(hits, intent, adaptiveCfg).kept;
  // The shadow list takes the same alias hop, trim to k, token budget and
  // return sizing, so it is compared with exactly what the caller got back.
  if (shadow && shadowHits) {
    startShadow(shadow, shadowHits, stageInput, kept, async (shadowRanked) => {
      let view = (await finishOrganic(await withAliasHop(shadowRanked))).slice(0, k);
      if (tokenBudget !== undefined) view = applyTokenBudget(view, tokenBudget);
      return applyAdaptiveReturn(view, intent, adaptiveCfg).kept;
    });
  }
  diagnostic?.mark("ranking");
  await report({
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
