/**
 * Information-retrieval metrics — pure functions over ranked result lists.
 *
 * No DB, no engine, no Bedrock: these take an ordered list of result ids
 * (a chunk/doc/slug identifier — the caller decides the id space, just be
 * consistent) plus a relevance judgement, and return a score. They are the
 * load-bearing math for the eval harness; the orchestration (loading qrels,
 * running search, aggregating) lives elsewhere so this stays trivially
 * testable and never couples to the serving path.
 *
 * Conventions:
 *   - `hits` is ranked best-first; rank is 1-indexed (hits[0] = rank 1).
 *   - `relevant` is the set of ids judged relevant for the query.
 *   - Binary relevance unless a `grades` map (id → gain ≥ 0) is supplied.
 *   - Every metric is defined for the degenerate inputs (empty hits, no
 *     relevant docs, k = 0) and returns 0 there rather than NaN/throwing,
 *     except Jaccard which is 1 for two empty sets (vacuously identical).
 */

/**
 * De-duplicate a ranked list, keeping each id's first (best) occurrence and
 * preserving order. A hit list may carry the same doc twice across the
 * chunk/doc id space; without this a repeated relevant id would inflate
 * precision/recall (recall could even exceed 1.0).
 */
export function distinctInOrder(hits: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

/** Fraction of the top-k (distinct) hits that are relevant. */
export function precisionAtK(
  hits: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) return 0;
  const top = distinctInOrder(hits).slice(0, k);
  if (top.length === 0) return 0;
  let found = 0;
  for (const h of top) if (relevant.has(h)) found++;
  return found / k;
}

/** Fraction of all relevant docs that appear in the top-k (distinct). */
export function recallAtK(
  hits: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0 || k <= 0) return 0;
  const top = distinctInOrder(hits).slice(0, k);
  let found = 0;
  for (const h of top) if (relevant.has(h)) found++;
  return found / relevant.size;
}

/**
 * Reciprocal rank of the first relevant hit (0 if none found). Ranks count
 * distinct ids, so a page that fills ranks 1-2 with two chunks pushes the next
 * page to rank 2, not 3.
 */
export function reciprocalRank(
  hits: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  const distinct = distinctInOrder(hits);
  for (let i = 0; i < distinct.length; i++) {
    if (relevant.has(distinct[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** Mean reciprocal rank over a set of per-query (hits, relevant) pairs. */
export function meanReciprocalRank(
  queries: ReadonlyArray<{ hits: readonly string[]; relevant: ReadonlySet<string> }>,
): number {
  if (queries.length === 0) return 0;
  let sum = 0;
  for (const q of queries) sum += reciprocalRank(q.hits, q.relevant);
  return sum / queries.length;
}

/**
 * Normalised Discounted Cumulative Gain @k.
 *   DCG@k  = Σ_{i=1..k} grade_i / log2(rank_i + 1)
 *   IDCG@k = same over grades sorted descending (the ideal ranking)
 *   nDCG@k = DCG@k / IDCG@k  (0 when IDCG = 0)
 * `grades` maps id → gain (≥ 0); ids absent from the map score 0.
 */
export function ndcgAtK(
  hits: readonly string[],
  grades: ReadonlyMap<string, number>,
  k: number,
): number {
  if (k <= 0) return 0;
  const top = distinctInOrder(hits).slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const g = grades.get(top[i]!) ?? 0;
    if (g > 0) dcg += g / Math.log2(i + 2); // rank = i+1 → log2(rank+1) = log2(i+2)
  }
  const idealGrades = [...grades.values()]
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGrades.length; i++) {
    idcg += idealGrades[i]! / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Jaccard overlap of the top-k of two ranked lists — a run-to-run stability
 * signal. 1 when both top-k sets are empty (vacuously identical), 0 when the
 * union is non-empty but the intersection is empty.
 */
export function jaccardAtK(
  a: readonly string[],
  b: readonly string[],
  k: number,
): number {
  if (k <= 0) return 1;
  const setA = new Set(a.slice(0, k));
  const setB = new Set(b.slice(0, k));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** True when the rank-1 hit is identical across two runs (top-1 stability). */
export function top1Stable(
  baseline: readonly string[],
  current: readonly string[],
): boolean {
  return (baseline[0] ?? null) === (current[0] ?? null);
}

/**
 * Build a binary-relevance grade map (every relevant id → gain 1) for nDCG.
 * Use when qrels carry a flat relevant-list with no graded judgements.
 */
export function binaryGrades(
  relevant: Iterable<string>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of relevant) m.set(id, 1);
  return m;
}
