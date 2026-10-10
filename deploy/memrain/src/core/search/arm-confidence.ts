/**
 * Keyword-arm confidence (MEMRAIN_RANK_KEYWORD_CONFIDENCE, default off).
 *
 * On a paraphrase query the keyword arm still returns AND matches — pages that
 * happen to hold the query's content words — and fuses them at full weight
 * next to a vector arm that understood the question. When the arm cannot tell
 * its own top page from the runner-up, its vote is noise more often than not,
 * so its lists (keyword and the title arm, the same lexical evidence) fuse at
 * half weight.
 *
 * "Cannot tell" is scale-free: `top / (top + second)` over the two best pages'
 * FTS scores. A tie is 0.5, a dominant page approaches 1, a single page is 1.
 * Raw ts_rank values depend on chunk length and curation factors, so a
 * threshold on them would not carry between corpora; the ratio does.
 */

/** Weight multiplier for the keyword and title lists when the arm is unsure. */
export const KEYWORD_WEAK_WEIGHT = 0.5;

/** Below this margin the keyword arm counts as unsure. */
export const KEYWORD_MARGIN_FLOOR = 0.6;

export interface ScoredKeywordRow {
  documentId: string;
  score: number;
}

/**
 * `top / (top + second)` over the best score per distinct page. 0 for an empty
 * arm (or no positive score), 1 when a single page matched.
 */
export function keywordMargin(rows: readonly ScoredKeywordRow[]): number {
  const best = new Map<string, number>();
  for (const r of rows) {
    const s = Number.isFinite(r.score) && r.score > 0 ? r.score : 0;
    if (s > (best.get(r.documentId) ?? 0)) best.set(r.documentId, s);
  }
  let top = 0;
  let second = 0;
  for (const s of best.values()) {
    if (s > top) {
      second = top;
      top = s;
    } else if (s > second) {
      second = s;
    }
  }
  if (top <= 0) return 0;
  if (best.size === 1) return 1;
  return top / (top + second);
}

export interface KeywordWeightInput {
  enabled: boolean;
  keywordRows: readonly ScoredKeywordRow[];
  /** The vector arm returned rows, so there is another opinion to defer to. */
  vectorVoted: boolean;
  /** The relational arm fused rows: an entity-shaped query, not a paraphrase. */
  relationalVoted: boolean;
}

/** True when the keyword and title lists should fuse at {@link KEYWORD_WEAK_WEIGHT}. */
export function downweightKeywordArm(input: KeywordWeightInput): boolean {
  return (
    input.enabled &&
    input.keywordRows.length > 0 &&
    input.vectorVoted &&
    !input.relationalVoted &&
    keywordMargin(input.keywordRows) < KEYWORD_MARGIN_FLOOR
  );
}
