/**
 * How `memrain bench scale` measures: nearest-rank percentiles over runs, the
 * query runner, and the connection sampler.
 *
 * Every search runs with each paid stage off, the query cache and telemetry
 * off, and its vector from the `embedQuery` seam — the counters record each
 * seam call so the report can show none came from anywhere else.
 */
import { PostgresEngine } from "../engine/postgres.ts";
import type { Storage } from "../storage.ts";
import { hybridSearch, type SearchOptions } from "../search/hybrid.ts";
import { benchQueryVector, queryList, type BenchQuery } from "./scale-corpus.ts";
import { APP_NAME } from "./scale-target.ts";

/** The ceil(q·n)-th smallest sample (nearest-rank). */
export function percentileNearestRank(samples: readonly number[], q: number): number {
  if (samples.length === 0) throw new Error("percentile of no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export interface LatencySummary {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  runP95: number[];
  /** (max − min) of the per-run p95s over their median; 0 for one run. */
  spreadP95: number | null;
}

export const round = (x: number): number => Math.round(x * 100) / 100;

export function summarizeRuns(runs: readonly (readonly number[])[]): LatencySummary {
  const all = runs.flat();
  const runP95 = runs.filter((r) => r.length > 0).map((r) => round(percentileNearestRank(r, 0.95)));
  if (all.length === 0) {
    return { samples: 0, p50: null, p95: null, p99: null, max: null, runP95, spreadP95: null };
  }
  const med = runP95.length > 0 ? percentileNearestRank(runP95, 0.5) : 0;
  return {
    samples: all.length,
    p50: round(percentileNearestRank(all, 0.5)),
    p95: round(percentileNearestRank(all, 0.95)),
    p99: round(percentileNearestRank(all, 0.99)),
    max: round(Math.max(...all)),
    runP95,
    spreadP95: med > 0 ? (Math.max(...runP95) - Math.min(...runP95)) / med : 0,
  };
}

export type Verdict = "pass" | "fail" | "no_data";

/** A report verdict, never an exception: a miss is a finding. */
export function judge(p95: number | null, targetMs: number): Verdict {
  if (p95 === null) return "no_data";
  return p95 <= targetMs ? "pass" : "fail";
}

export type ErrorCounts = Record<string, number>;

/** SQLSTATE classes and driver codes that mean "no connection", not "bad query". */
function isConnectionError(code: string): boolean {
  return (
    code.startsWith("08") ||
    code === "53300" ||
    code === "57P01" ||
    code === "57P03" ||
    /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED)$/.test(code)
  );
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && code ? code : "unknown";
}

export interface Counters {
  embedSeamCalls: number;
  hybridQueries: number;
}

export type Mode = "keyword" | "hybrid";

/** Per-call options: every paid stage off, cache and telemetry off, vector from the seam. */
export function searchOptions(seed: string, counters: Counters): SearchOptions {
  return {
    k: 20,
    rerank: false,
    graphRerank: false,
    noExpansion: true,
    noCache: true,
    noTelemetry: true,
    embedQuery: async (text: string) => {
      counters.embedSeamCalls++;
      return benchQueryVector(seed, text);
    },
  };
}

/**
 * Run `queries` with `concurrency` workers; latencies in ms of the ones that
 * returned, error counts by code for the rest. Keyword mode is the brain's own
 * keyword-only switch, set around the call and restored after.
 */
export async function runQueries(
  storage: Storage,
  queries: readonly BenchQuery[],
  mode: Mode,
  concurrency: number,
  opts: SearchOptions,
  counters: Counters,
): Promise<{ latencies: number[]; errors: ErrorCounts }> {
  const latencies: number[] = [];
  const errors: ErrorCounts = {};
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const q = queries[next++]!;
      if (mode === "hybrid") counters.hybridQueries++;
      const t0 = performance.now();
      try {
        await hybridSearch(storage, q.text, opts);
        latencies.push(performance.now() - t0);
      } catch (err) {
        const code = errorCode(err);
        errors[code] = (errors[code] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { latencies, errors };
}

export function mergeErrors(into: ErrorCounts, from: ErrorCounts): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

export function connectionErrorCount(errors: ErrorCounts): number {
  return Object.entries(errors).reduce((n, [k, v]) => n + (isConnectionError(k) ? v : 0), 0);
}

/**
 * Keyword-only for the duration of `fn`. Process-wide, so a keyword phase and
 * a hybrid phase never overlap; the harness runs them one after the other.
 */
async function inMode<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  if (mode === "hybrid") return fn();
  const prev = process.env.MEMRAIN_KEYWORD_ONLY;
  process.env.MEMRAIN_KEYWORD_ONLY = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MEMRAIN_KEYWORD_ONLY;
    else process.env.MEMRAIN_KEYWORD_ONLY = prev;
  }
}

export interface ProtocolParams {
  seed: string;
  queries: number;
  runs: number;
  warmup: number;
  concurrency: number;
}

/** Warmup, then `runs` runs of the fixed list; one summary and the errors of every run. */
export async function measure(
  storage: Storage,
  label: string,
  mode: Mode,
  p: ProtocolParams,
  counters: Counters,
): Promise<{ summary: LatencySummary; errors: ErrorCounts; runs: number[][] }> {
  const opts = searchOptions(p.seed, counters);
  const errors: ErrorCounts = {};
  return inMode(mode, async () => {
    if (p.warmup > 0) {
      const w = await runQueries(storage, queryList(p.seed, `${label}:warmup`, p.warmup), mode, p.concurrency, opts, counters);
      mergeErrors(errors, w.errors);
    }
    const list = queryList(p.seed, `${label}:run`, p.queries);
    const runs: number[][] = [];
    for (let r = 0; r < p.runs; r++) {
      const res = await runQueries(storage, list, mode, p.concurrency, opts, counters);
      runs.push(res.latencies);
      mergeErrors(errors, res.errors);
    }
    return { summary: summarizeRuns(runs), errors, runs };
  });
}

/** Peak backend count on bench databases, sampled every 50ms on the admin server. */
export class ConnectionSampler {
  peakTotal = 0;
  peakPerDb: Record<string, number> = {};
  private scenarioPeak = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly engine: PostgresEngine;

  constructor(adminUrl: string) {
    this.engine = new PostgresEngine({ url: adminUrl, max: 1, applicationName: `${APP_NAME}-sampler` });
  }

  start(): void {
    this.timer = setInterval(() => void this.sample(), 50);
  }

  /** Peak since the last call. */
  takeScenarioPeak(): number {
    const p = this.scenarioPeak;
    this.scenarioPeak = 0;
    return p;
  }

  async sample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.engine.query<{ db: string; n: number }>(
        `SELECT datname AS db, count(*)::int AS n FROM pg_stat_activity
          WHERE datname LIKE 'memrain\\_bench\\_%' GROUP BY datname`,
      );
      let total = 0;
      for (const row of r.rows) {
        const n = Number(row.n);
        total += n;
        this.peakPerDb[row.db] = Math.max(this.peakPerDb[row.db] ?? 0, n);
      }
      this.peakTotal = Math.max(this.peakTotal, total);
      this.scenarioPeak = Math.max(this.scenarioPeak, total);
    } catch {
      // A sample lost to a restart is a gap in the curve, not a failed bench.
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.engine.close().catch(() => undefined);
  }
}
