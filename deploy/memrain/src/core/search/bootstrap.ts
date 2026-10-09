/**
 * Seeded bootstrap intervals for retrieval metrics.
 *
 * The eval sets are small (the live replay set scores ~9 queries), so one
 * query flipping moves hit rate by 0.11. A bare point number cannot tell that
 * apart from a real regression; a percentile bootstrap over the per-query
 * scores can. Everything here is seeded (default 42) so two runs over the same
 * scores print the same interval — an interval that wobbles between runs would
 * be one more source of noise.
 *
 * Cost is O(iterations × n) for the resampling plus one sort of the
 * `iterations` resampled means for the percentile pick.
 */

export interface BootstrapOptions {
  /** Resamples. Default 2000. */
  iterations?: number;
  /** PRNG seed. Default 42. */
  seed?: number;
  /** Two-sided miss rate; 0.05 gives a 95% interval. */
  alpha?: number;
}

export interface BootstrapCI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
  iterations: number;
  seed: number;
}

/** The compact `{lo, hi}` form the reports carry. */
export interface Ci95 {
  lo: number;
  hi: number;
}

export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_BOOTSTRAP_SEED = 42;

/** mulberry32 — a tiny 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isConstant(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i] !== values[0]) return false;
  return true;
}

/** Percentile bootstrap interval for the mean of `values`. */
export function bootstrapMeanCI(
  values: readonly number[],
  opts: BootstrapOptions = {},
): BootstrapCI {
  const iterations = Math.max(1, Math.floor(opts.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS));
  const seed = opts.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const alpha = opts.alpha ?? 0.05;
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n, iterations, seed };

  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  // Every resample of a constant sample has the same mean; skip the float
  // round-off that summing it again would introduce.
  if (n === 1 || isConstant(values)) return { mean, lo: mean, hi: mean, n, iterations, seed };

  const rand = mulberry32(seed);
  const means = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rand() * n)]!;
    means[b] = s / n;
  }
  means.sort();
  const loIdx = Math.min(iterations - 1, Math.max(0, Math.floor((alpha / 2) * iterations)));
  const hiIdx = Math.min(iterations - 1, Math.max(0, Math.ceil((1 - alpha / 2) * iterations) - 1));
  // The sample mean sits inside its own percentile interval except in
  // pathological skew; clamp so a report never shows mean outside [lo, hi].
  const lo = Math.min(means[loIdx]!, mean);
  const hi = Math.max(means[hiIdx]!, mean);
  return { mean, lo, hi, n, iterations, seed };
}

/**
 * Paired bootstrap interval for mean(after − before). Resampling the per-query
 * differences resamples query indices jointly, so the query-difficulty
 * variance shared by both runs cancels instead of widening the interval.
 */
export function pairedBootstrapDeltaCI(
  before: readonly number[],
  after: readonly number[],
  opts: BootstrapOptions = {},
): BootstrapCI {
  if (before.length !== after.length) {
    throw new Error(
      `pairedBootstrapDeltaCI: length mismatch (before=${before.length}, after=${after.length})`,
    );
  }
  const deltas = after.map((a, i) => a - before[i]!);
  return bootstrapMeanCI(deltas, opts);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Compact, rounded 95% interval for a report field. */
export function ci95(values: readonly number[], opts: BootstrapOptions = {}): Ci95 {
  const r = bootstrapMeanCI(values, opts);
  return { lo: round4(r.lo), hi: round4(r.hi) };
}

/** Compact, rounded 95% interval for a paired delta. */
export function deltaCi95(
  before: readonly number[],
  after: readonly number[],
  opts: BootstrapOptions = {},
): Ci95 {
  const r = pairedBootstrapDeltaCI(before, after, opts);
  return { lo: round4(r.lo), hi: round4(r.hi) };
}

/**
 * What each metric in the eval JSON outputs means. Keys are the field names
 * the reports emit, so a reader can look any of them up directly.
 */
export const METRIC_GLOSSARY: Readonly<Record<string, string>> = {
  meanRecall:
    "Recall@k averaged over queries that have expected paths: share of a query's expected paths found in the top k distinct pages.",
  meanReciprocalRank:
    "MRR: mean of 1/rank of the first expected hit (0 when none is retrieved). Ranks count distinct pages, so two chunks of one page hold one rank.",
  scoredQueries: "Queries with expected paths: the n behind every mean and interval.",
  abstention:
    "Queries with no expected paths, kept out of the averages. falsePositiveRate is the share of them that returned any hit (there is no score threshold).",
  replayedIdsSha256: "sha256 of the sorted replayed query ids; trends compare like with like only when it matches.",
  unscored: "Replay queries without an expected document: outside meanRR and hitRate; returnedAny counts those with any result.",
  meanRR: "MRR over captured replay queries that name an expected document.",
  hitRate: "Share of queries with at least one expected hit in the top k.",
  meanNdcg:
    "nDCG@k with binary relevance: discounted gain of the expected hits divided by the ideal ordering's gain.",
  meanPrecision: "P@k: expected hits in the top k divided by k, averaged over queries.",
  wilsonCi95: "95% Wilson score interval for hitRate treated as a binomial proportion.",
  recallCi95: "95% percentile bootstrap interval for meanRecall (2000 resamples of queries, seed 42).",
  mrrCi95: "95% percentile bootstrap interval for MRR (2000 resamples of queries, seed 42).",
  recall_ci95: "Same as recallCi95 (run-all records and gate output).",
  mrr_ci95: "Same as mrrCi95 (run-all records and gate output).",
  ndcg: "Same as meanNdcg (run-all records).",
  precision: "Same as meanPrecision (run-all records).",
  meanRRCi95: "95% percentile bootstrap interval for meanRR (2000 resamples, seed 42).",
  hitRateCi95: "95% percentile bootstrap interval for hitRate (2000 resamples, seed 42).",
  delta_ci95:
    "Paired bootstrap 95% interval for current − baseline over the n queries present in both runs (of `scored`), with the paired point deltas; an interval entirely below 0 is a drop beyond noise. The pass/fail verdict compares full-set means, so it can differ when n < scored.",
  deltaMeanRRCi95: "Paired bootstrap 95% interval for meanRR − baseline meanRR (replay), over the same `paired` queries as deltaMeanRR.",
  deltaHitRateCi95: "Paired bootstrap 95% interval for hitRate − baseline hitRate (replay), over the same `paired` queries as deltaHitRate.",
  qrels_changed: "The baseline was scored against different qrels bytes, so the comparison is not like for like.",
  significantDrop: "True when the paired delta interval for MRR lies entirely below 0.",
  run_config_hash:
    "sha256 of the resolved ranking knobs (explicit config over MEMRAIN_* env over the search-mode bundle), the ranking env knobs, the embedding signature, k and qrels_sha256. Equal hashes mean the same ranking configuration; the corpus is not covered, so runs against a changed brain can differ under one hash.",
  qrels_sha256: "sha256 of the qrels file bytes the run scored against.",
};
