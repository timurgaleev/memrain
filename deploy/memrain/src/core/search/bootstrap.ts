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

export interface PairedClusterStatistics {
  /** mean(b − a) over the paired queries. */
  delta: number;
  lower95: number;
  upper95: number;
  /** Two-sided sign-flip randomization p-value over clusters. */
  p_value: number;
  /** Queries where b scored above / below / equal to a. */
  wins: number;
  losses: number;
  ties: number;
  n: number;
  clusters: number;
  /** True when every sign assignment was enumerated rather than sampled. */
  exact: boolean;
}

/** Up to this many clusters every sign assignment is enumerated (2^16). */
export const EXACT_SIGN_FLIP_MAX_CLUSTERS = 16;
const SAMPLED_SIGN_FLIPS = 20000;

/**
 * Paired A/B statistics where queries that share a cluster (paraphrases of one
 * question, say) move together: treating them as independent would count one
 * finding several times and shrink the p-value. The interval resamples whole
 * clusters; the p-value flips the sign of each cluster's summed difference,
 * which is the exact null of "A and B are exchangeable" for paired data.
 */
export function pairedClusterStatistics(
  a: readonly number[],
  b: readonly number[],
  clusters: readonly string[],
  opts: BootstrapOptions = {},
): PairedClusterStatistics {
  if (a.length !== b.length || a.length !== clusters.length) {
    throw new Error(
      `pairedClusterStatistics: length mismatch (a=${a.length}, b=${b.length}, clusters=${clusters.length})`,
    );
  }
  const n = a.length;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  const sums = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const d = b[i]! - a[i]!;
    if (d > 0) wins++;
    else if (d < 0) losses++;
    else ties++;
    const c = sums.get(clusters[i]!) ?? { sum: 0, count: 0 };
    sums.set(clusters[i]!, { sum: c.sum + d, count: c.count + 1 });
  }
  const groups = [...sums.values()];
  const base = { wins, losses, ties, n, clusters: groups.length };
  if (n === 0) {
    return { delta: 0, lower95: 0, upper95: 0, p_value: 1, exact: true, ...base };
  }
  const total = groups.reduce((s, g) => s + g.sum, 0);
  const delta = total / n;
  // Float sums of the same terms in another order can differ in the last
  // bits; without the tolerance the observed statistic may fail to count
  // itself.
  const eps = 1e-9 * Math.max(1, Math.abs(total));
  const observed = Math.abs(total);

  let extreme = 0;
  let draws: number;
  const exact = groups.length <= EXACT_SIGN_FLIP_MAX_CLUSTERS;
  const rand = mulberry32(opts.seed ?? DEFAULT_BOOTSTRAP_SEED);
  if (exact) {
    draws = 2 ** groups.length;
    for (let mask = 0; mask < draws; mask++) {
      let s = 0;
      for (let j = 0; j < groups.length; j++) s += mask & (1 << j) ? -groups[j]!.sum : groups[j]!.sum;
      if (Math.abs(s) >= observed - eps) extreme++;
    }
  } else {
    draws = SAMPLED_SIGN_FLIPS;
    for (let t = 0; t < draws; t++) {
      let s = 0;
      for (const g of groups) s += rand() < 0.5 ? -g.sum : g.sum;
      if (Math.abs(s) >= observed - eps) extreme++;
    }
  }
  // A sampled p-value counts the observed assignment as one of the draws, so
  // it never reports 0.
  const p_value = exact ? extreme / draws : (extreme + 1) / (draws + 1);

  const iterations = Math.max(1, Math.floor(opts.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS));
  const alpha = opts.alpha ?? 0.05;
  const means = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    let m = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rand() * groups.length)]!;
      s += g.sum;
      m += g.count;
    }
    means[it] = s / m;
  }
  means.sort();
  const loIdx = Math.min(iterations - 1, Math.max(0, Math.floor((alpha / 2) * iterations)));
  const hiIdx = Math.min(iterations - 1, Math.max(0, Math.ceil((1 - alpha / 2) * iterations) - 1));
  return {
    delta: round4(delta),
    lower95: round4(Math.min(means[loIdx]!, delta)),
    upper95: round4(Math.max(means[hiIdx]!, delta)),
    // Unrounded: a sampled p-value can sit below 1e-4, and rounding it to 0
    // would claim a certainty the sampling cannot give.
    p_value,
    exact,
    ...base,
  };
}

/**
 * Holm step-down adjustment: controls the chance of any false finding across
 * the family of tests without Bonferroni's full penalty on the smaller
 * p-values. Returns adjusted values in the input order.
 */
export function holmAdjusted(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const out = Array.from<number>({ length: m });
  let running = 0;
  for (let rank = 0; rank < m; rank++) {
    const { p, i } = order[rank]!;
    // Monotone: an adjusted value never drops below the one before it.
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  }
  return out;
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
  paired:
    "A/B: per metric, B − A over the scored queries both sides answered: delta, a cluster-bootstrap 95% interval (lower95, upper95), a two-sided sign-flip p_value over clusters (exact up to 16 clusters), p_holm adjusted across the metrics, and per-query wins/losses/ties. aggregate_only means a query threw on a side, so only the means compare.",
  latency: "Search wall time per query, p50 and p95 in ms, over queries that did not throw; A/B adds B/A ratios.",
  expected_top1: "Queries whose qrel pins an expected page at rank 1, and the ids that missed it.",
  receipt:
    "What an A/B scored: the split, qrels and query-id hashes, the prereg sha256 when one was given, and both run-config hashes.",
};
