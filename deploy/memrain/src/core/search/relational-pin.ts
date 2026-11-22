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
 * After the rerank, the relational pages in the window (at most `max`) form a
 * block at the head of the window, above the reranked text rows. Each claims
 * `min(relationalRank, rerankedIndex)`, where `relationalRank` is its 0-based
 * rank among the relational pages in the pre-rerank order: the first
 * relational answer claims place 0 wherever fusion put it, and one the
 * reranker itself lifted keeps that claim. Claims sort ascending, ties going
 * to the pre-rerank order (the reranker cannot judge an edge-derived row, so
 * it may reorder them only when strictly decisive). Every other row (text
 * rows, and relational rows past `max`) follows in its reranked order, so it
 * lands at its reranked position or at most `pinned` places lower.
 *
 * Known cost: the pin trusts the relational arm. A wrong arm (the parser
 * matched a relationship shape and the anchor resolved, but the edges are
 * stale) puts up to `max` edge-derived pages at the head. The size is the
 * MEMRAIN_RELATIONAL_RERANK_PIN knob (0..10, default 3); 0 or `off` turns the
 * pin off and leaves the reranked order as it is.
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

/** Default pin size (covers hit@3). */
export const RELATIONAL_PIN_MAX = 3;
/** Largest pin size the knob accepts. */
export const RELATIONAL_PIN_LIMIT = 10;

/**
 * MEMRAIN_RELATIONAL_RERANK_PIN: an integer 0..RELATIONAL_PIN_LIMIT, or
 * `off` / `false` for 0. Unset or anything else is the default.
 */
export function relationalPinMax(raw: string | undefined = process.env["MEMRAIN_RELATIONAL_RERANK_PIN"]): number {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "false") return 0;
  if (!/^\d+$/.test(v)) return RELATIONAL_PIN_MAX;
  const n = Number(v);
  return n <= RELATIONAL_PIN_LIMIT ? n : RELATIONAL_PIN_MAX;
}

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

  // Each relational page's rank among the relational pages before the rerank.
  const relRank = new Map<string, number>();
  for (const h of preRerank) {
    const key = hitPageKey(h);
    if (relationalPages.has(key) && !relRank.has(key)) relRank.set(key, relRank.size);
  }

  const seen = new Set<string>();
  const claims: Array<{ idx: number; rel: number; claim: number }> = [];
  reranked.forEach((h, idx) => {
    const key = hitPageKey(h);
    const rel = relRank.get(key);
    if (rel === undefined || seen.has(key)) return;
    seen.add(key);
    claims.push({ idx, rel, claim: Math.min(rel, idx) });
  });
  if (claims.length === 0) return unchanged;

  claims.sort((a, b) => a.claim - b.claim || a.rel - b.rel || a.idx - b.idx);
  const block = claims.slice(0, max);
  const inBlock = new Set(block.map((c) => c.idx));
  const order: Hit[] = [...block.map((c) => reranked[c.idx]!), ...reranked.filter((_, i) => !inBlock.has(i))];
  if (order.every((h, i) => h === reranked[i])) return { hits: [...reranked], pinned: block.length };
  return { hits: order.map((h, i) => ({ ...h, score: order.length - i })), pinned: block.length };
}
