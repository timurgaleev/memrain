/**
 * Query-level confidence grade for the operator meta channel.
 *
 * Per-hit evidence (evidence.ts) says why one hit matched; the caller also
 * needs one word for the whole answer: did the brain find the thing, or only
 * something near it? The grade reads the evidence already stamped on the
 * returned hits, so it costs nothing and needs no score calibration (fused
 * scores are rank-based and carry no absolute meaning).
 *
 *   strong   — the top hit is an identity or two-arm match (title, alias, both arms)
 *   moderate — the top hit is a keyword match, or a later head hit is strong
 *   weak     — no hits, or the head holds only semantic neighbours
 *   unknown  — a cache hit: the stored ranking carries no arm membership, so
 *              its default evidence would grade the same query differently
 *              from the miss that stored it (reason "cache_hit")
 *
 * Operator-only: on an empty fenced result a grade would still describe
 * content the caller cannot see, so publicSearchMeta never carries it.
 */
import type { Evidence } from "./evidence.ts";
import { RANK_BAND } from "./evidence.ts";
import { isTitlePhraseMatch } from "./title-match.ts";

export type ConfidenceGrade = "strong" | "moderate" | "weak" | "unknown";

export interface SearchConfidence {
  grade: ConfidenceGrade;
  reason: string;
}

/** The grade a cache hit reports; see the header for why it claims nothing. */
export const CACHE_HIT_CONFIDENCE: SearchConfidence = { grade: "unknown", reason: "cache_hit" };

const STRONG: ReadonlySet<Evidence> = new Set(["exact_title_match", "alias_hit", "high_vector_match"]);

export function gradeConfidence(
  hits: ReadonlyArray<{ evidence?: Evidence }>,
): SearchConfidence {
  const top = hits[0]?.evidence;
  if (top === undefined) return { grade: "weak", reason: "no hits" };
  if (STRONG.has(top)) return { grade: "strong", reason: `top hit: ${top}` };
  if (top === "keyword_exact") return { grade: "moderate", reason: "top hit: keyword_exact" };
  const later = hits.slice(1, RANK_BAND).find((h) => h.evidence !== undefined && h.evidence !== "weak_semantic");
  if (later?.evidence) return { grade: "moderate", reason: `top hit weak, head holds ${later.evidence}` };
  return { grade: "weak", reason: "head holds only weak_semantic hits" };
}

/** What the rerank gate knows about the arms before the rerank runs. */
export interface RerankGateInput {
  query: string;
  /** Title of the current top hit. */
  topTitle: string | null | undefined;
  /** Titles of the other hits the rerank would see. */
  otherTitles?: ReadonlyArray<string | null | undefined>;
  /** Page key of the current top hit. */
  topPage: string;
  /** Page of the first hydrated row each primary arm returned. */
  vectorTopPage?: string;
  keywordTopPage?: string;
}

/**
 * A strong grade, read before the paid rerank: the top hit's title holds the
 * query as a phrase (`exact_title_match`) and no other hit in the window's
 * does (two such titles are exactly what the rerank separates), or the vector
 * and the keyword arm both put the top hit's page first. Stricter than the returned-hit grade,
 * whose two-arm signal only asks that both 30-deep lists contain the chunk:
 * that is too common to justify skipping the rerank on.
 */
export function rerankConfident(g: RerankGateInput): boolean {
  if (isTitlePhraseMatch(g.query, g.topTitle) && !(g.otherTitles ?? []).some((t) => isTitlePhraseMatch(g.query, t))) return true;
  return g.vectorTopPage !== undefined && g.vectorTopPage === g.topPage && g.keywordTopPage === g.topPage;
}
