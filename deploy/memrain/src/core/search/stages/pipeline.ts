/**
 * The post-fusion stages, in the order hybridSearch runs them. See types.ts.
 *
 * Boosts run on the full candidate set before any collapse, so a boost decides
 * which chunk of a page survives the per-document cap. The two-pass rerank
 * runs before the near-duplicate drop so it can order twins the drop then
 * resolves; exact lookup runs last so nothing after it can demote the page the
 * whole query names.
 */
import { skipMetadataBoosts } from "../metadata-boost-gate.ts";
import { applySourceBoost } from "../source-boost.ts";
import {
  recencyBoostMultiplierForPath,
  recencyMultiplierForPath,
  resolveRecencyBoostMap,
  resolveRecencyDecayMap,
} from "../recency.ts";
import { chronicleBoostMultiplier } from "../chronicle-boost.ts";
import { applyMatteringBoost, salienceMultiplier } from "../salience.ts";
import { applyGraphSignals, computeFloorThreshold } from "../graph-signals.ts";
import { applyBacklinkBoost } from "../backlink-boost.ts";
import { exactMatchBoostForTaxonomy, exactMatchIndices } from "../intent-weights.ts";
import { slugCandidatesForPath } from "../page-slug.ts";
import { pageKeyFor } from "../page-fusion.ts";
import { applyAliasResolvedBoost, ALIAS_RESOLVED_BOOST } from "../alias-resolved.ts";
import { getTitleBoost, isTitlePhraseMatch } from "../title-match.ts";
import { isCanonicalQuery } from "../recency-gate.ts";
import { dedupByDocument, dedupByTextSimilarity, enforceTypeDiversity, getMaxTypeRatio, getNearDupThreshold } from "../dedup.ts";
import { rerank } from "../two-pass.ts";
import { hitPageKey, pinRelationalRows, relationalPinMax } from "../relational-pin.ts";
import { rerankConfident, rerankGateMode } from "../confidence-grade.ts";
import { promoteExactLookup } from "../exact-lookup.ts";
import { feedbackRankStage } from "../feedback-boost.ts";
import { mergeExplain, recordStageFactor, snapshotScores, type SearchExplain } from "../explain.ts";
import type { SearchOptions } from "../hybrid.ts";
import type { Hit, RankStage, StageContext, StageInput } from "./types.ts";

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

/** A relative score floor for the graph-based boosts, or undefined for none. */
function floorFor(hits: Hit[], ctx: StageContext): number | undefined {
  const floor = computeFloorThreshold(hits, ctx.graphFloorRatio);
  return Number.isFinite(floor) ? floor : undefined;
}

/** Run an in-place stage and attribute its factor per chunk when explaining. */
async function attributed(
  hits: Hit[],
  ctx: StageContext,
  label: Parameters<typeof recordStageFactor>[3],
  run: () => Promise<void>,
): Promise<Hit[]> {
  const before = ctx.explainAcc ? snapshotScores(hits) : null;
  await run();
  if (ctx.explainAcc && before) recordStageFactor(ctx.explainAcc, before, hits, label);
  return hits;
}

// 5d. Compiled-truth boost — a page's canonical answers (its compiled-truth
//     mirror chunks) get ×2 so the distilled truth outranks body prose for
//     the same page. Applied ONLY at detail=low (see COMPILED_TRUTH_BOOST):
//     at medium/high the cross-page displacement outweighs the tilt.
//     Pre-dedup like every other boost, so the truth chunk wins the
//     per-doc collapse of its own mirror document.
const compiledTruth: RankStage = {
  name: "compiled-truth",
  costClass: "free",
  enabled: (ctx) => compiledTruthBoost(ctx.opts.detail, ctx.detailResolved, ctx.rank.entityTruthSoft) > 1,
  apply: async (hits, ctx) => {
    const truthBoost = compiledTruthBoost(ctx.opts.detail, ctx.detailResolved, ctx.rank.entityTruthSoft);
    for (const s of hits) {
      if (s.payload?.sourcePath?.startsWith(PAGE_TRUTH_PREFIX)) {
        s.score *= truthBoost;
        if (ctx.explainAcc) mergeExplain(ctx.explainAcc, s.chunkId, { compiled_truth: truthBoost });
      }
    }
    return hits;
  },
};

// 6. Source-boost.
const sourceBoost: RankStage = {
  name: "source",
  costClass: "free",
  enabled: () => true,
  apply: async (hits, ctx) => {
    const before = ctx.explainAcc ? snapshotScores(hits) : null;
    const boosted = applySourceBoost(hits);
    if (ctx.explainAcc && before) recordStageFactor(ctx.explainAcc, before, boosted, "source");
    return boosted;
  },
};

// 6b. Recency (documents.effective_date) + salience (frontmatter pinned/weight)
//     — gentle post-fusion multipliers on the LIVE model. Immutable like
//     the rest of the pipeline; both are neutral (1.0) when their signal
//     is absent, so neither can bury a hit that doesn't declare it.
//     Canonical/definitional queries ("who is X", "define X", a bare symbol)
//     skip recency + salience (an explicit temporal bound re-enables
//     freshness). The title-phrase boost nudges a page whose title holds the
//     query as a contiguous phrase (inert when MEMRAIN_TITLE_BOOST <= 1.0).
//     Recency BOOST lifts fresh content when the classifier (or an explicit
//     per-call recency bias) asks for it.
const recencySalience: RankStage = {
  name: "recency-salience-title",
  costClass: "free",
  enabled: () => true,
  apply: async (hits, ctx) => {
    const nowMs = Date.now();
    const { canonical, skipMetadata, recencyBoostMode, query: trimmed } = ctx;
    // Per-prefix recency decay (env-overridable); paths matching no prefix
    // (e.g. code chunks under `src/`) fall back to the original uniform decay.
    const recencyMap = getRecencyDecayMap();
    const titleBoost = getTitleBoost();
    const titleBoostActive = Number.isFinite(titleBoost) && titleBoost > 1.0;
    const recencyBoostMap = recencyBoostMode === "off" ? null : getRecencyBoostMap();
    return hits.map((s) => {
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
      // Curation tiers act ONLY inside the arm SQL (the prefix factor shapes
      // per-arm LIMIT survival; there is no curation stage here). Multiplying
      // the fused score again would double-apply the tier map and over-tilt
      // low-tier prefixes like chat/ 0.5.
      const titleF =
        titleBoostActive && isTitlePhraseMatch(trimmed, s.payload?.title) ? titleBoost : 1;
      // Life-Chronicle lift for life/events + life/diary hits — gated on the same
      // recency-boost activation, so a non-temporal query leaves every hit at ×1
      // (bit-for-bit unchanged). Pure ranking; the diary read-fence lives elsewhere.
      const chronicleF = skipMetadata
        ? 1
        : chronicleBoostMultiplier(s.payload?.sourcePath, recencyBoostMode);
      if (ctx.explainAcc) {
        const patch: Partial<SearchExplain> = {};
        if (recencyF !== 1) patch.recency = recencyF;
        if (salienceF !== 1) patch.salience = salienceF;
        if (titleF !== 1) patch.title = titleF;
        if (chronicleF !== 1) patch.chronicle = chronicleF;
        mergeExplain(ctx.explainAcc, s.chunkId, patch);
      }
      return { ...s, score: s.score * recencyF * salienceF * titleF * chronicleF };
    });
  },
};

// 6b2. Mattering-salience join — the cycle-computed pages.salience score
//      (emotional-weight tags + link degree + takes) lifts "what matters"
//      pages when the query asks for current context (meeting prep / catch-up
//      phrasings). Classifier-gated; canonical queries never fire it. An
//      explicit per-call salience bias wins over classifier + canonical gate;
//      'strong' selects the aggressive coefficient. Fail-open; floor-gated
//      like the other metadata boosts.
const mattering: RankStage = {
  name: "mattering",
  costClass: "free",
  enabled: (ctx) => {
    const on = ctx.opts.salience !== undefined
      ? ctx.opts.salience !== "off"
      : !ctx.canonical && ctx.suggestions.suggestedSalience === "on";
    return on && !ctx.skipMetadata;
  },
  apply: async (hits, ctx) => {
    const floor = computeFloorThreshold(hits, ctx.graphFloorRatio);
    return attributed(hits, ctx, "mattering", async () => {
      try {
        await applyMatteringBoost(hits, ctx.engine, {
          strength: ctx.opts.salience === "strong" ? "strong" : "on",
          ...(Number.isFinite(floor) ? { floorThreshold: floor } : {}),
        });
      } catch {
        // A pages lookup error leaves scores intact.
      }
    });
  },
};

// 6c. Graph signals (opt-in, default OFF) — adjacency hub boost + session
//     diversification over the link graph, applied pre-dedup on the full
//     scored set so a hub's chunk can rise before per-doc collapse. Mutates
//     score in place; fail-open (a links query error leaves scores intact).
//     The relative floor (MEMRAIN_GRAPH_SIGNALS_FLOOR) collapses to undefined
//     when unset, so the disabled path is byte-identical to the pre-floor call.
const graphSignals: RankStage = {
  name: "graph-signals",
  costClass: "free",
  enabled: (ctx) => ctx.graphSignalsOn && !ctx.skipMetadata,
  apply: async (hits, ctx) => {
    const floorThreshold = floorFor(hits, ctx);
    return attributed(hits, ctx, "graph", () => applyGraphSignals(hits, ctx.engine, {
      enabled: true,
      floorThreshold,
      ...(ctx.opts.sourceIds ? { sourceIds: ctx.opts.sourceIds } : {}),
    }));
  },
};

// 6d. Backlink-count boost (default ON) — a standing hub signal: multiply each
//     hit by 1 + 0.05*ln(1+inbound_link_count) using the page's GLOBAL
//     in-degree from the `links` table. Floor-ratio-gated by the SAME
//     MEMRAIN_GRAPH_SIGNALS_FLOOR ratio (undefined → every hit eligible).
//     Pre-dedup so the boost decides which chunk survives per-doc collapse;
//     fail-open on a links query error.
const backlink: RankStage = {
  name: "backlink",
  costClass: "free",
  enabled: (ctx) => ctx.backlinkBoostOn && !ctx.skipMetadata,
  apply: async (hits, ctx) => {
    const floorThreshold = floorFor(hits, ctx);
    return attributed(hits, ctx, "backlink", () => applyBacklinkBoost(hits, ctx.engine, {
      floorThreshold,
      ...(ctx.opts.sourceIds ? { sourceIds: ctx.opts.sourceIds } : {}),
    }));
  },
};

// 6e. Exact-match boost — a hit whose slug / kebab-slug / title IS the query
//     wins the tie on entity/event queries (the user typed the thing's name).
//     Lexical-relevance signal: NOT floor-gated, applied outside the metadata gate.
const exactMatch: RankStage = {
  name: "exact-match",
  costClass: "free",
  enabled: (ctx) => exactMatchBoostForTaxonomy(ctx.suggestions.taxonomy) > 1.0,
  apply: async (hits, ctx) => {
    const exactBoost = exactMatchBoostForTaxonomy(ctx.suggestions.taxonomy);
    const cands = hits.map((s) => ({
      slugs: slugCandidatesForPath(s.payload?.sourcePath ?? null, s.payload?.source_id ?? null),
      title: s.payload?.title ?? null,
    }));
    for (const i of exactMatchIndices(cands, ctx.query)) {
      const s = hits[i]!;
      s.score *= exactBoost;
      if (ctx.explainAcc) mergeExplain(ctx.explainAcc, s.chunkId, { exact: exactBoost });
    }
    return hits;
  },
};

// 6f. Alias-resolved canonical boost (×1.05) — pages that old slugs forward
//     to (slug_aliases canonical side) are the explicitly disambiguated
//     authority. Fail-open: a pre-migration store no-ops.
const aliasResolved: RankStage = {
  name: "alias-resolved",
  costClass: "free",
  enabled: (ctx) => !ctx.skipMetadata,
  apply: async (hits, ctx) => {
    try {
      const touched = await applyAliasResolvedBoost(hits, ctx.engine);
      if (ctx.explainAcc) {
        for (const i of touched) mergeExplain(ctx.explainAcc, hits[i]!.chunkId, { alias: ALIAS_RESOLVED_BOOST });
      }
    } catch {
      // Non-fatal — the boost is a nudge, never a dependency.
    }
    return hits;
  },
};

// Re-sort after boost + recency (RRF was already sorted but these flip).
const resort: RankStage = {
  name: "sort",
  costClass: "free",
  enabled: () => true,
  apply: async (hits) => hits.sort((a, b) => b.score - a.score),
};

// 7. Per-document dedup — cap 2 chunks per document (one strong page may show
//    its two best chunks, the rest yield slots to other pages). Skipped for
//    `exact` intent and detail 'high' (the all-chunks view). Structural walks
//    deliberately surface multiple neighbor chunks from the same document, so
//    the cap widens with the walk depth. The cap is per PAGE, not per
//    document: a page's mirror (`page://x`), its compiled-truth mirror
//    (`page-truth://x`) and its file twin (`x.md`) are three documents that
//    would otherwise take three caps' worth of slots.
const perDocument: RankStage = {
  name: "per-document",
  costClass: "free",
  enabled: (ctx) => !(ctx.intent === "exact" || ctx.opts.detail === "high"),
  apply: async (hits, ctx) => {
    const maxPerDoc = ctx.structural
      ? Math.min(10, Math.max((ctx.opts.walkDepth ?? 0) * 5, 5))
      : ctx.opts.detail === "low"
        ? 1
        : 2;
    ctx.typeDiversityBasis = dedupByDocument(hits, { enabled: true, maxPerDoc }).length;
    return dedupByDocument(hits, {
      enabled: true,
      maxPerDoc,
      keyOf: (h) => {
        const p = (h as Hit).payload;
        return pageKeyFor(p?.sourcePath, p?.source_id, h.documentId);
      },
    });
  },
};

// 7b. Type-diversity layer: no page type may exceed MEMRAIN_MAX_TYPE_RATIO
//     (default 0.6) of the candidate set, so one noisy shape (chat exports,
//     dailies) can't monopolise every slot. Skipped for `exact` intent,
//     structural walks and detail 'high' (all deliberately homogeneous).
const typeDiversity: RankStage = {
  name: "type-diversity",
  costClass: "free",
  enabled: (ctx) => !(ctx.intent === "exact" || ctx.structural || ctx.opts.detail === "high"),
  apply: async (hits, ctx) => enforceTypeDiversity(hits, getMaxTypeRatio(), ctx.typeDiversityBasis),
};

// 8. Two-pass rerank (opt-in) — runs BEFORE near-dup so the reranker sees
//    both near-identical twins and decides their order; near-dup then drops
//    the now-lower-ranked one. It reranks a candidate window wider than the
//    return size (MEMRAIN_RERANK_WINDOW, default 30, clamped to at least k and
//    to the candidates available) so a hit fused below the cutoff can still be
//    promoted; the un-reranked tail keeps its fused order behind the window.
//    The relational arm's pages go back to the head of the window afterwards
//    (relational-pin.ts). With MEMRAIN_RERANK_GATE=shadow the head is graded
//    first (rerankConfident) and the outcome says whether the call would have
//    been skipped; it always runs.
export async function rerankWindow(
  hits: Hit[],
  ctx: StageContext,
  rerankFn: (query: string, window: Hit[]) => Promise<Hit[]> = rerank,
): Promise<Hit[]> {
  const gate = ctx.rerankGate;
  const top = hits[0];
  const size = Math.min(hits.length, Math.max(ctx.k, resolveRerankWindow()));
  const graded = gate && top && rerankGateMode() === "shadow"
    ? {
        reason: rerankConfident({
          query: ctx.query,
          topTitle: top.payload?.title,
          otherTitles: hits.slice(1, size).map((h) => h.payload?.title),
          topPage: hitPageKey(top),
          vectorTopPage: gate.vectorTopPage,
          keywordTopPage: gate.keywordTopPage,
        }),
      }
    : null;
  const window = hits.slice(0, size);
  const pin = pinRelationalRows(await rerankFn(ctx.query, window), window, gate?.relationalPages ?? new Set(), relationalPinMax());
  ctx.onRerank?.({
    outcome: "ran",
    pinned: pin.pinned,
    ...(graded ? { would_skip: graded.reason !== null, ...(graded.reason ? { gate_reason: graded.reason } : {}) } : {}),
  });
  const reranked = [...pin.hits, ...hits.slice(size)];
  if (ctx.explainAcc) {
    const preRerankOrder = new Map(hits.map((h, i) => [h.chunkId, i] as const));
    reranked.forEach((h, i) => {
      const prev = preRerankOrder.get(h.chunkId);
      if (prev !== undefined && prev !== i) mergeExplain(ctx.explainAcc!, h.chunkId, { rerank_delta: prev - i });
    });
  }
  return reranked;
}

const twoPassRerank: RankStage = {
  name: "two-pass-rerank",
  costClass: "paid",
  enabled: (ctx) => ctx.rerankWanted,
  apply: (hits, ctx) => rerankWindow(hits, ctx),
};

// 8b. Near-dup dedup across documents (Jaccard on text) — two DIFFERENT docs
//     can still carry near-identical text (a note + its `.bak`); drop the
//     lower-ranked twin. Skipped for `exact` intent or when
//     MEMRAIN_NEARDUP_JACCARD > 1.0.
const nearDuplicate: RankStage = {
  name: "near-duplicate",
  costClass: "free",
  enabled: (ctx) => ctx.intent !== "exact" && getNearDupThreshold() <= 1.0,
  apply: async (hits) => dedupByTextSimilarity(hits, getNearDupThreshold()),
};

// 8b2. Exact lookup (MEMRAIN_RANK_EXACT_LOOKUP): the one page the whole query
//      names goes to rank 1. See exact-lookup.ts.
const exactLookup: RankStage = {
  name: "exact-lookup",
  costClass: "free",
  enabled: (ctx) => ctx.rank.exactLookup,
  apply: async (hits, ctx) => promoteExactLookup(hits, ctx.query),
};

export const POST_FUSION_STAGES: readonly RankStage[] = [
  compiledTruth,
  sourceBoost,
  recencySalience,
  mattering,
  graphSignals,
  backlink,
  exactMatch,
  aliasResolved,
  resort,
  feedbackRankStage,
  perDocument,
  typeDiversity,
  twoPassRerank,
  nearDuplicate,
  exactLookup,
];

/** Derive the shared per-call values once. */
export function stageContext(input: StageInput): StageContext {
  // Metadata-boost gate (MEMRAIN_RANK_METADATA_GATE): on a query only the
  // vector arm answered, the metadata stages stand down and the similarity
  // order stands. See metadata-boost-gate.ts.
  const skipMetadata = skipMetadataBoosts({ enabled: input.rank.metadataGate, ...input.votes });
  const canonical = isCanonicalQuery(input.query);
  // An explicit per-call recency bias overrides both the classifier and the
  // canonical gate (the agent asserted the temporal intent).
  const recencyBoostMode = input.opts.recency ?? (canonical ? "off" : input.suggestions.suggestedRecency);
  return { ...input, skipMetadata, canonical, recencyBoostMode };
}

/** Whether any enabled stage could spend: the shadow ranker refuses such a call. */
export function paidStageEnabled(input: StageInput): boolean {
  const ctx = stageContext(input);
  return POST_FUSION_STAGES.some((s) => s.costClass === "paid" && s.enabled(ctx));
}

/** Run every enabled stage, in order, over the hydrated candidates. */
export async function runPostFusionStages(hits: Hit[], input: StageInput): Promise<Hit[]> {
  const ctx = stageContext(input);
  let current = hits;
  for (const stage of POST_FUSION_STAGES) {
    if (!stage.enabled(ctx)) continue;
    current = await stage.apply(current, ctx);
    ctx.onStage?.(stage.name, current);
  }
  return current;
}
