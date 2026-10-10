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
 *
 * Operator-only: on an empty fenced result a grade would still describe
 * content the caller cannot see, so publicSearchMeta never carries it.
 */
import type { Evidence } from "./evidence.ts";
import { RANK_BAND } from "./evidence.ts";

export type ConfidenceGrade = "strong" | "moderate" | "weak";

export interface SearchConfidence {
  grade: ConfidenceGrade;
  reason: string;
}

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
