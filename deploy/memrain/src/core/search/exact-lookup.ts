/**
 * Exact lookup (MEMRAIN_RANK_EXACT_LOOKUP, default off).
 *
 * When the whole query is one page's title or slug, the caller named that page
 * and it belongs at rank 1, whatever the fused scores say. The exact-match
 * boost (intent-weights.ts) only nudges, and only for entity/event phrasing, so
 * a page whose body never repeats its own name still loses to bodies that do.
 *
 * Runs after near-dup and before alias-hop. It only reorders: the named page's
 * best chunk moves to the head and every other hit keeps its relative order.
 * Two different pages both matching is an ambiguity this tier does not settle,
 * so it then leaves the list alone. The moved hit's score is lifted just above
 * the old head so a later score sort (alias-hop re-sorts) keeps it there.
 */
import { exactMatchIndices } from "./intent-weights.ts";
import { slugCandidatesForPath } from "./page-slug.ts";
import { pageKeyFor } from "./page-fusion.ts";

export interface ExactLookupCandidate {
  documentId: string;
  score: number;
  payload?: {
    title?: string | null;
    sourcePath?: string | null;
    source_id?: string | null;
  };
}

export function promoteExactLookup<T extends ExactLookupCandidate>(
  hits: readonly T[],
  query: string,
): T[] {
  if (hits.length < 2) return [...hits];
  const matched = exactMatchIndices(
    hits.map((h) => ({
      slugs: slugCandidatesForPath(h.payload?.sourcePath ?? null, h.payload?.source_id ?? null),
      title: h.payload?.title ?? null,
    })),
    query,
  );
  if (matched.size === 0) return [...hits];
  const pages = new Set(
    [...matched].map((i) =>
      pageKeyFor(hits[i]!.payload?.sourcePath, hits[i]!.payload?.source_id, hits[i]!.documentId),
    ),
  );
  if (pages.size !== 1) return [...hits];
  const at = Math.min(...matched);
  if (at === 0) return [...hits];
  const head = hits[0]!;
  const promoted = { ...hits[at]!, score: Math.max(hits[at]!.score, head.score * (1 + 1e-6)) };
  return [promoted, ...hits.slice(0, at), ...hits.slice(at + 1)];
}
