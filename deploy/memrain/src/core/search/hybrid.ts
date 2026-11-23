/**
 * Hybrid search: a keyword arm and a vector arm, fused by reciprocal rank.
 *
 * Pipeline:
 *   1. keyword retrieval (Postgres full text) and, in parallel, the query
 *      embedding followed by vector retrieval; both arms push the source scope,
 *      the visibility filter, the date/type/slug filters and the default
 *      hard-excludes into their own SQL
 *   2. RRF fuse the two lists
 *   3. hydrate the fused chunks with their document, re-asserting scope,
 *      visibility and filters as the single choke point
 *   4. keep at most two chunks per page (a page's mirror, truth mirror and file
 *      twin meet on one page key)
 *   5. trim to k, then the optional token budget
 *
 * No model is called except the query embedding. A failed or slow embed falls
 * back to keyword-only and says so in the meta; a budget refusal is the
 * operator's policy and reaches the caller. Owner-only, diary and quarantine
 * fences and the trust frame are applied by the caller (mcp/dispatch.ts) on the
 * returned hits.
 */
import { withSearchSlot } from "../pool-budget.ts";
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { isOperationError } from "../operation-error.ts";
import { embedText } from "../embedding.ts";
import { reciprocalRankFusion } from "../rrf.ts";
import { isStatementTimeoutError } from "../retry.ts";
import { keywordOnlyMode } from "../llm/gateway.ts";
import { visibilityClause } from "../visibility.ts";
import { andSourceScope, isNoGrant } from "../source-scope.ts";
import { DEGRADED_REASONS, type DegradedReason, type SearchMeta } from "./search-meta.ts";
import { vectorSearch } from "./vector.ts";
import { keywordSearch } from "./keyword.ts";
import { pageFilterClauses, validatePageFilters, type ChunkFilters } from "./filters.ts";
import { getSearchExcludePrefixes, isExcludedPath } from "./curation.ts";
import { dedupByDocument, type ChunkScore } from "./dedup.ts";
import { pageKeyFor } from "./page-fusion.ts";
import { applyTokenBudget } from "./token-budget.ts";

export interface SearchOptions {
  k?: number;
  embeddingModel?: string;
  /**
   * Query-embedder injection. Defaults to the Titan embedder; set only by
   * hermetic tests to drive the vector arm with deterministic vectors.
   */
  embedQuery?: (text: string) => Promise<number[]>;
  rrfK?: number;
  /** Restrict to these sources. Undefined is unscoped; `[]` reads nothing. */
  sourceIds?: readonly string[];
  /** Caller cancellation: the embed is skipped or aborted and the search stops. */
  signal?: AbortSignal;
  /** Cap on the estimated tokens (chars/4) of the returned title + content, in rank order. */
  tokenBudget?: number;
  /** Observational side channel: how the search ran. A throwing listener is ignored. */
  onMeta?: (meta: SearchMeta) => void;
  types?: readonly string[];
  slugPrefix?: string;
  /** Keep only docs whose content date COALESCE(effective_date, updated_at) is >= this ISO date. */
  since?: string;
  /** Keep only docs whose content date is <= this ISO date. */
  until?: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  title: string | null;
  content: string;
  score: number;
  source_id: string | null;
  /** The content date as YYYY-MM-DD: the effective date, else the last update. */
  date: string | null;
  date_source: "effective" | "updated";
  /** Set when `content` was cut to fit a `tokenBudget` (trailing "…"). */
  truncated?: boolean;
}

/** Chunks kept per page after fusion. */
const MAX_PER_PAGE = 2;

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

const QUERY_EMBED_TIMEOUT_MS = (() => {
  const n = Number(process.env.MEMRAIN_QUERY_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6_000;
})();

class QueryEmbedDeadlineError extends Error {
  override name = "QueryEmbedDeadlineError";
}

/**
 * Embed the query under a wall-clock deadline: the abort signal reaches the
 * Bedrock call, and a timer races it so a connection that ignores the abort
 * still cannot hold the search past the budget.
 */
async function embedQueryBounded(text: string, opts: SearchOptions, signal: AbortSignal): Promise<number[]> {
  const p = opts.embedQuery
    ? opts.embedQuery(text)
    : embedText(text, {
        modelId: opts.embeddingModel ?? EMBED_MODEL,
        abortSignal: signal,
        requestTimeoutMs: Math.max(500, Math.floor(QUERY_EMBED_TIMEOUT_MS / 3)),
      });
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new QueryEmbedDeadlineError(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      QUERY_EMBED_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reportMeta(opts: SearchOptions, meta: SearchMeta): void {
  if (!opts.onMeta) return;
  try {
    opts.onMeta({ ...meta, degraded: DEGRADED_REASONS.filter((r) => meta.degraded.includes(r)) });
  } catch {
    // The meta channel is observational; a broken listener never fails a search.
  }
}

function contentDate(effective: string | null, updated: string | null): Pick<SearchHit, "date" | "date_source"> {
  const value = effective ?? updated;
  const parsed = value ? new Date(value) : null;
  return {
    date: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null,
    date_source: effective ? "effective" : "updated",
  };
}

interface HydratedRow {
  id: string;
  document_id: string;
  content: string;
  source_path: string;
  title: string | null;
  source_id: string | null;
  effective_date: string | null;
  updated_at: string | null;
}

async function hydrate(engine: Engine, ids: readonly string[], opts: SearchOptions, filters: ChunkFilters | undefined): Promise<Map<string, HydratedRow>> {
  if (ids.length === 0) return new Map();
  const params: unknown[] = [ids];
  const sourceFilter = andSourceScope("d.source_id", opts.sourceIds, params);
  const pageFilter = pageFilterClauses(params, filters);
  const rows = await engine.query<HydratedRow>(
    `SELECT c.id, c.document_id, c.content, d.source_path, d.title, d.source_id,
            d.effective_date::text AS effective_date, d.updated_at::text AS updated_at
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])
        AND ${visibilityClause("d")}${sourceFilter}${pageFilter}`,
    params,
  );
  return new Map(rows.rows.map((r) => [r.id, r]));
}

/** Bounded by MEMRAIN_SEARCH_MAX_CONCURRENT when set (core/pool-budget.ts). */
export function hybridSearch(storage: Storage, query: string, optsOrK: SearchOptions | number = {}): Promise<SearchHit[]> {
  const opts: SearchOptions = typeof optsOrK === "number" ? { k: optsOrK } : optsOrK;
  return withSearchSlot(() => searchUnbounded(storage, query, opts));
}

async function searchUnbounded(storage: Storage, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  opts.signal?.throwIfAborted();
  const trimmed = (query ?? "").trim();
  if (!trimmed) throw new Error("hybridSearch: query must be non-empty");
  // A caller granted no source reads nothing: return before any arm or a paid
  // embedding call can touch the brain.
  if (isNoGrant(opts.sourceIds)) {
    reportMeta(opts, { vectorEnabled: false, degraded: [], retrieved: 0, returned: 0 });
    return [];
  }
  validatePageFilters(opts);
  const k = opts.k ?? 10;
  const fanout = Math.max(20, k * 3);
  const engine = storage.engine();
  const filters: ChunkFilters | undefined = opts.since || opts.until || opts.types?.length || opts.slugPrefix
    ? {
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
        ...(opts.types?.length ? { types: opts.types } : {}),
        ...(opts.slugPrefix ? { slugPrefix: opts.slugPrefix } : {}),
      }
    : undefined;
  const armOpts = { sourceIds: opts.sourceIds, filters, sourceBoost: true };
  const degraded: DegradedReason[] = [];

  // Settle the keyword arm eagerly so its rejection is never left unobserved
  // while the embed runs.
  const keyword = keywordSearch(engine, trimmed, fanout, armOpts).then(
    (ids) => ids,
    (error: unknown) => {
      opts.signal?.throwIfAborted();
      if (isOperationError(error) && error.code === "budget_exhausted") throw error;
      degraded.push(isStatementTimeoutError(error) ? "keyword_timeout" : "keyword_arm_failed");
      return [] as string[];
    },
  );

  let queryVector: number[] | null = null;
  if (!keywordOnlyMode()) {
    const deadline = AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    try {
      queryVector = await embedQueryBounded(trimmed, opts, signal);
    } catch (e) {
      // A budget refusal is the operator's policy, not a flaky embedder: it
      // reaches the caller instead of looking like an empty brain.
      if ((isOperationError(e) && e.code === "budget_exhausted") || opts.signal?.aborted) {
        await keyword.catch(() => {});
        throw e;
      }
      const timedOut = e instanceof QueryEmbedDeadlineError || deadline.aborted;
      degraded.push(timedOut ? "embed_timeout" : "vector_arm_failed");
    }
  }
  const vectorIds = queryVector
    ? await vectorSearch(engine, queryVector, fanout, {
        ...armOpts,
        onCandidatesIncomplete: () => degraded.push("vector_candidates_incomplete"),
      }).catch((error: unknown) => {
        opts.signal?.throwIfAborted();
        degraded.push("vector_arm_failed");
        queryVector = null;
        console.error("[search] vector arm failed:", error instanceof Error ? error.message : error);
        return [] as string[];
      })
    : [];
  const keywordIds = await keyword;
  opts.signal?.throwIfAborted();
  if (keywordIds.length === 0 && !degraded.includes("keyword_timeout") && !degraded.includes("keyword_arm_failed")) {
    degraded.push("keyword_zero");
  }

  const fused = reciprocalRankFusion([vectorIds, keywordIds], { k: opts.rrfK }).slice(0, fanout);
  const rows = await hydrate(engine, fused.map((f) => f.id), opts, filters);
  opts.signal?.throwIfAborted();

  const excludePrefixes = getSearchExcludePrefixes();
  const scored: ChunkScore<HydratedRow>[] = [];
  for (const f of fused) {
    const row = rows.get(f.id);
    if (!row) continue;
    if (excludePrefixes.length > 0 && isExcludedPath(row.source_path, excludePrefixes)) continue;
    scored.push({ chunkId: row.id, documentId: row.document_id, score: f.score, payload: row });
  }
  const perPage = dedupByDocument(scored, {
    maxPerDoc: MAX_PER_PAGE,
    keyOf: (h) => {
      const row = h.payload as HydratedRow;
      return pageKeyFor(row.source_path, row.source_id, row.document_id);
    },
  });
  const ranked: SearchHit[] = perPage.slice(0, k).map((h) => {
    const row = h.payload!;
    return {
      chunkId: row.id,
      documentId: row.document_id,
      sourcePath: row.source_path,
      title: row.title,
      content: row.content,
      score: h.score,
      source_id: row.source_id,
      ...contentDate(row.effective_date, row.updated_at),
    };
  });
  let hits = ranked;
  if (opts.tokenBudget !== undefined) {
    hits = applyTokenBudget(ranked, opts.tokenBudget);
    if (hits.length < ranked.length) degraded.push("budget_truncated");
  }
  reportMeta(opts, { vectorEnabled: queryVector !== null, degraded, retrieved: fused.length, returned: hits.length });
  return hits;
}
