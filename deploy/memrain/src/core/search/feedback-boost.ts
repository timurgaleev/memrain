/**
 * Feedback stage: reorder the final list by score · m, with m the page's
 * feedback multiplier (core/feedback/weights.ts), so a page people found
 * useful sits a little higher. m stays within 1 ± λ and is 1 for a page
 * nobody rated, so a brain without ratings ranks exactly as before.
 *
 * Only the order changes: `score` (and with it explain, autocut and the
 * evidence grade) keeps the value the earlier stages gave it. Weights are kept
 * per page in the page's own source, so a hit is weighed only by votes on the
 * page it points at. Off (MEMRAIN_FEEDBACK unset) the stage reads nothing.
 * Fail-open: any error returns the list untouched.
 */
import type { Engine } from "../engine/interface.ts";
import { feedbackEnabled } from "../feedback/settings.ts";
import { feedbackGeneration, readWeights } from "../feedback/store.ts";
import { feedbackMultiplier } from "../feedback/weights.ts";
import { slugForSourcePath } from "./graph-signals.ts";
import type { RankStage } from "./stages/types.ts";

export interface FeedbackScorable {
  score: number;
  payload?: { sourcePath?: string } | undefined;
}

export async function applyFeedbackStage<T extends FeedbackScorable>(engine: Engine, hits: T[]): Promise<T[]> {
  if (!feedbackEnabled() || hits.length === 0) return hits;
  try {
    const slugOf = (h: T) => slugForSourcePath(h.payload?.sourcePath ?? "");
    const weights = await readWeights(engine, hits.map(slugOf).filter((s) => s.length > 0));
    if (weights.size === 0) return hits;
    const keyed = hits.map((h, index) => {
      const w = weights.get(slugOf(h));
      const m = w === undefined ? 1 : feedbackMultiplier(w);
      return { h, index, key: h.score >= 0 ? h.score * m : h.score / m };
    });
    keyed.sort((a, b) => b.key - a.key || a.index - b.index);
    return keyed.map((k) => k.h);
  } catch {
    return hits;
  }
}

/**
 * The pipeline entry: right after the score sort, so the per-document cap,
 * type diversity, the reranker and exact lookup still have the last word.
 */
export const feedbackRankStage: RankStage = {
  name: "feedback",
  costClass: "free",
  enabled: () => feedbackEnabled(),
  apply: (hits, ctx) => applyFeedbackStage(ctx.engine, hits),
};

/**
 * The query-cache key suffix: empty while feedback is off, so the key is the
 * one search always used; on, it changes with every weight.
 */
export async function feedbackCacheSuffix(engine: Engine): Promise<string> {
  if (!feedbackEnabled()) return "";
  try {
    return `:fb=${await feedbackGeneration(engine)}`;
  } catch {
    // Unreadable weights: a key no other search shares, so nothing stale is served.
    return `:fb=err-${Date.now()}-${Math.random()}`;
  }
}
