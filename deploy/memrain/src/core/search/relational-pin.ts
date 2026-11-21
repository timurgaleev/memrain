/**
 * Relational rows keep their place through the two-pass rerank.
 *
 * The relational arm answers "who founded Acme" with the pages a typed edge
 * points at. The founder's page need not mention Acme anywhere: only the
 * `founded` edge connects them. The reranker judges each candidate by its
 * title, path and an excerpt, so it ranks those pages below any page that
 * merely holds the query's words, and on a relationship question that pushes
 * the right answer out of the first few places.
 *
 * After the rerank, each relational page in the window (at most `max`) gets
 * back the place the reranker took from it: it claims
 * `min(preRerankIndex, rerankedIndex)` in the window, so the pin only restores
 * places, never lifts a page above where it stood before the rerank, and a
 * page the reranker lifted keeps the lift. Text rows fill the other places in
 * the reranker's order, so one lands at its reranked position or at most
 * `pinned` places lower, never higher.
 *
 * A permutation of the reranked window: nothing is added or removed, a row
 * below the window (which the reranker never saw) is never lifted, and a page
 * a stage before the rerank dropped (the per-page cap, type diversity) is
 * never brought back. One row per page is pinned (its highest reranked row).
 * When the rerank left the order as it was (its fail-open paths return the
 * input order), there is nothing to undo and the window is returned unchanged.
 * A moved window is re-scored the way the rerank scores it (window length
 * down to 1), so a later score sort keeps the pinned order.
 */
import type { Hit } from "./stages/types.ts";
import { pageKeyFor } from "./page-fusion.ts";

/** How many relational pages the pin may hold at the head (covers hit@3). */
export const RELATIONAL_PIN_MAX = 3;

export function hitPageKey(h: Hit): string {
  return pageKeyFor(h.payload?.sourcePath, h.payload?.source_id, h.documentId);
}

export interface RelationalPinResult {
  hits: Hit[];
  /** Relational rows placed in the head block (whether or not they moved). */
  pinned: number;
}

/**
 * @param reranked   the reranked window
 * @param preRerank  the same rows in the order the rerank received them
 * @param relationalPages page keys the relational arm returned
 */
export function pinRelationalRows(
  reranked: readonly Hit[],
  preRerank: readonly Hit[],
  relationalPages: ReadonlySet<string>,
  max = RELATIONAL_PIN_MAX,
): RelationalPinResult {
  const unchanged = { hits: [...reranked], pinned: 0 };
  if (max <= 0 || relationalPages.size === 0 || reranked.length === 0) return unchanged;
  if (reranked.length === preRerank.length && reranked.every((h, i) => h.chunkId === preRerank[i]!.chunkId)) {
    return unchanged;
  }

  // Each page's place before the rerank (its first row in the window).
  const preIndex = new Map<string, number>();
  preRerank.forEach((h, i) => {
    const key = hitPageKey(h);
    if (relationalPages.has(key) && !preIndex.has(key)) preIndex.set(key, i);
  });

  const seen = new Set<string>();
  const claims: Array<{ idx: number; pre: number; claim: number }> = [];
  reranked.forEach((h, idx) => {
    const key = hitPageKey(h);
    const pre = preIndex.get(key);
    if (pre === undefined || seen.has(key)) return;
    seen.add(key);
    claims.push({ idx, pre, claim: Math.min(pre, idx) });
  });
  if (claims.length === 0) return unchanged;

  // Ties go to the pre-rerank order: the reranker cannot judge an edge-derived
  // row, so it may lift one past another only when strictly ahead.
  claims.sort((a, b) => a.claim - b.claim || a.pre - b.pre || a.idx - b.idx);
  const block = claims.slice(0, max);
  const inBlock = new Set(block.map((c) => c.idx));
  const rest = reranked.filter((_, i) => !inBlock.has(i));
  // A pinned row takes its claimed place, or the next free one; text rows fill the rest.
  const order: Hit[] = [];
  let b = 0;
  let r = 0;
  while (order.length < reranked.length) {
    const next = block[b];
    if (next && (next.claim <= order.length || r >= rest.length)) {
      order.push(reranked[next.idx]!);
      b++;
    } else {
      order.push(rest[r++]!);
    }
  }
  if (order.every((h, i) => h === reranked[i])) return { hits: [...reranked], pinned: block.length };
  return { hits: order.map((h, i) => ({ ...h, score: order.length - i })), pinned: block.length };
}
