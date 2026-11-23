/**
 * Search meta — what a caller needs to tell "the brain has nothing" from "the
 * search ran degraded". `hybridSearch` reports it through the `onMeta` side
 * channel; the hits array itself never changes shape.
 *
 * The degraded vocabulary is closed on purpose. A non-operator caller gets
 * only the codes that describe the pipeline rather than the corpus: counts,
 * keyword_zero and budget_truncated are all computed before the dispatch-side
 * page and diary fences, so on an empty fenced result they would still tell
 * the caller that hidden content matched its query.
 */
export const DEGRADED_REASONS = [
  "embed_timeout",
  "vector_arm_failed",
  "keyword_timeout",
  "keyword_arm_failed",
  "keyword_zero",
  "budget_truncated",
  "vector_candidates_incomplete",
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface SearchMeta {
  /** A query vector was available, so the vector arm served this call. */
  vectorEnabled: boolean;
  degraded: DegradedReason[];
  /** Candidates in the fused pool, before hydrate, dedup and the k trim. */
  retrieved: number;
  returned: number;
}

export interface PublicSearchMeta {
  vectorEnabled: boolean;
  degraded: DegradedReason[];
}

/** Reason codes that do not depend on what the corpus holds. */
const CORPUS_INDEPENDENT_REASONS: ReadonlySet<DegradedReason> = new Set([
  "embed_timeout",
  "vector_arm_failed",
  "keyword_timeout",
  "keyword_arm_failed",
]);

/** The meta a non-operator caller (public ingress or an OAuth tenant) sees. */
export function publicSearchMeta(meta: SearchMeta): PublicSearchMeta {
  return {
    vectorEnabled: meta.vectorEnabled,
    degraded: meta.degraded.filter((r) => CORPUS_INDEPENDENT_REASONS.has(r)),
  };
}

const REASON_TEXT: Record<DegradedReason, string> = {
  embed_timeout: "vector arm unavailable (embed_timeout)",
  vector_arm_failed: "vector arm unavailable (vector_arm_failed)",
  keyword_timeout: "keyword arm timed out",
  keyword_arm_failed: "keyword arm unavailable",
  keyword_zero: "keyword search found nothing",
  budget_truncated: "token budget dropped hits",
  vector_candidates_incomplete: "vector arm ran out of candidates inside the filter",
};

/** One-line explanation of an empty result, for the CLI's stderr. */
export function formatDegradedNotice(
  meta: Pick<SearchMeta, "degraded" | "vectorEnabled">,
): string {
  if (meta.degraded.length === 0) return "no results";
  const parts = meta.degraded.map((r) =>
    r === "keyword_zero" && !meta.vectorEnabled
      ? "keyword-only search found nothing"
      : REASON_TEXT[r],
  );
  return `no results - ${parts.join("; ")}`;
}
