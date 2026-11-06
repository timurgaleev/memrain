/**
 * CPU-time measurement for linearity tests. Wall-clock ratios swing with
 * whatever else the machine runs; the process's own CPU time does not.
 * Bun has no `threadCpuUsage`, so this reads `process.cpuUsage()`, which is
 * per process: fine inside one test file, where nothing else runs at the
 * same time.
 */

/**
 * Process CPU time also counts the engine's GC and JIT threads, which add up
 * to about a millisecond of noise to any one run. A side cheaper than this
 * is clamped to it, so noise over a near-zero denominator cannot fail a
 * ratio; size workloads so the small side costs more than this.
 */
const FLOOR_MS = 1;

function runCpuMs(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const { user, system } = process.cpuUsage(before);
  return (user + system) / 1000;
}

/** Best (minimum) CPU milliseconds, user + system, over `repeat` runs of `fn`. */
export function cpuMs(fn: () => void, opts: { repeat?: number } = {}): number {
  const repeat = opts.repeat ?? 3;
  let best = Infinity;
  for (let i = 0; i < repeat; i++) best = Math.min(best, runCpuMs(fn));
  return best;
}

/**
 * CPU-time ratio large/small, best of `repeat` for each side. The order
 * alternates across repeats so warm-up and GC debt do not always land on
 * the same side.
 */
export function linearityRatio(small: () => void, large: () => void, opts: { repeat?: number } = {}): number {
  const repeat = opts.repeat ?? 3;
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let i = 0; i < repeat; i++) {
    if (i % 2 === 0) {
      bestSmall = Math.min(bestSmall, runCpuMs(small));
      bestLarge = Math.min(bestLarge, runCpuMs(large));
    } else {
      bestLarge = Math.min(bestLarge, runCpuMs(large));
      bestSmall = Math.min(bestSmall, runCpuMs(small));
    }
  }
  return Math.max(bestLarge, FLOOR_MS) / Math.max(bestSmall, FLOOR_MS);
}
