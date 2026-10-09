/**
 * `memrain eval run-all|compare|gate` — the aggregate instrument that proves a
 * ranking change over memrain's qrels harness:
 *
 *   eval run-all [--modes a,b,c] [--qrels PATH] [--k N] [--out PATH]
 *       Run the qrels suite once per search mode (knobs from MODE_BUNDLES,
 *       applied per-call — no env mutation) and append one JSONL record per
 *       run to the results log (default: <config-dir>/eval-results.jsonl).
 *
 *   eval compare [--input PATH] [--json]
 *       Render the per-mode comparison from the results log. Latest run per
 *       (suite, mode) wins — matches how an operator re-runs after a fix.
 *
 *   eval gate [--baseline PATH] [--max-drop X] [--min-recall X]
 *             [--write-baseline] [--qrels PATH] [--k N]
 *       Regression gate: run the CURRENT config over qrels and compare to a
 *       stored baseline JSON. Fails (exit 1) when meanRecall or MRR dropped
 *       by more than --max-drop (default 0.05), or — without a baseline —
 *       when meanRecall < --min-recall (correctness floor, default 0.6).
 *       --write-baseline saves this run as the new baseline.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig, defaultConfigPath } from "../core/config.ts";
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  isSearchMode,
  type SearchMode,
} from "../core/search/mode.ts";
import {
  evalRun,
  loadQrels,
  defaultQrelsPath,
  expectedTargets,
  presentTargetPaths,
  staleQrelsReason,
  EXIT_STALE_QRELS,
  EVAL_SCORING_VERSION,
  type EvalKnobConfig,
  type EvalOptions,
  type EvalReport,
} from "./eval.ts";
import { deltaCi95, METRIC_GLOSSARY, type Ci95 } from "../core/search/bootstrap.ts";

export interface EvalResultRecord {
  run_id: string;
  ran_at: string;
  suite: string;
  mode: string;
  status: "completed" | "failed";
  duration_ms: number;
  error?: string;
  /** Absent on records written before the run fingerprint existed. */
  run_config_hash?: string;
  qrels_sha256?: string;
  metrics?: {
    mean_recall: number;
    mean_mrr: number;
    hit_rate: number;
    ndcg?: number;
    precision?: number;
    recall_ci95?: Ci95;
    mrr_ci95?: Ci95;
  };
}

export function defaultResultsPath(): string {
  return join(dirname(defaultConfigPath()), "eval-results.jsonl");
}

/** Knob set for a mode, built from the bundle (per-call, no env mutation). */
export function configForMode(mode: SearchMode): EvalKnobConfig {
  const b = MODE_BUNDLES[mode];
  return {
    name: mode,
    expansion: b.expansion,
    rerank: b.rerank,
    graphSignals: b.graphSignals,
    cosineRescore: b.cosineRescore,
    relationalArm: b.relationalArm,
    ...(b.tokenBudget !== undefined ? { tokenBudget: b.tokenBudget } : {}),
  };
}

export interface EvalRunAllOptions {
  modes?: string[];
  qrelsPath?: string;
  k?: number;
  out?: string;
  configPath?: string;
  searchFn?: EvalOptions["searchFn"];
}

export async function runEvalRunAll(opts: EvalRunAllOptions = {}): Promise<number> {
  const modes: SearchMode[] = [];
  for (const m of opts.modes ?? [...SEARCH_MODES]) {
    if (!isSearchMode(m)) {
      console.error(`memrain eval run-all: invalid mode '${m}' (${SEARCH_MODES.join("|")})`);
      return 1;
    }
    modes.push(m);
  }
  const qrels = loadQrels(opts.qrelsPath ?? defaultQrelsPath());
  const out = opts.out ?? defaultResultsPath();
  mkdirSync(dirname(out), { recursive: true });

  const storage = new Storage(loadConfig(opts.configPath));
  const records: EvalResultRecord[] = [];
  const stale = await withStorage(storage, async () => {
    const targets = expectedTargets(qrels);
    const reason = staleQrelsReason(targets, await presentTargetPaths(storage, targets));
    if (reason) return reason;
    for (const mode of modes) {
      const started = Date.now();
      const base: Omit<EvalResultRecord, "status" | "duration_ms"> = {
        run_id: `run-${randomUUID().slice(0, 8)}`,
        ran_at: new Date().toISOString(),
        suite: "qrels",
        mode,
      };
      try {
        const report = await evalRun(storage, qrels, configForMode(mode), {
          ...(opts.k !== undefined ? { k: opts.k } : {}),
          ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
        });
        records.push({
          ...base,
          status: "completed",
          duration_ms: Date.now() - started,
          run_config_hash: report.run_config_hash,
          qrels_sha256: report.qrels_sha256,
          metrics: {
            mean_recall: report.meanRecall,
            mean_mrr: report.meanReciprocalRank,
            hit_rate: report.hitRate,
            ndcg: report.meanNdcg,
            precision: report.meanPrecision,
            recall_ci95: report.recallCi95,
            mrr_ci95: report.mrrCi95,
          },
        });
      } catch (e) {
        records.push({
          ...base,
          status: "failed",
          duration_ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return null;
  });
  if (stale) {
    console.error(stale);
    return EXIT_STALE_QRELS;
  }

  for (const r of records) appendFileSync(out, JSON.stringify(r) + "\n");
  console.log(
    JSON.stringify(
      {
        ok: records.every((r) => r.status === "completed"),
        out,
        records,
        glossary: METRIC_GLOSSARY,
      },
      null,
      2,
    ),
  );
  return records.every((r) => r.status === "completed") ? 0 : 1;
}

function readResults(path: string): EvalResultRecord[] {
  if (!existsSync(path)) return [];
  const records: EvalResultRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EvalResultRecord;
      if (r && typeof r === "object" && r.run_id && r.mode && r.suite) records.push(r);
    } catch {
      // append-only file — one corrupt line must not tank the compare
    }
  }
  return records;
}

/** Latest record per (suite, mode). */
export function groupLatest(
  records: EvalResultRecord[],
): Record<string, Partial<Record<string, EvalResultRecord>>> {
  const out: Record<string, Partial<Record<string, EvalResultRecord>>> = {};
  for (const r of records) {
    const suite = (out[r.suite] ??= {});
    const existing = suite[r.mode];
    if (!existing || r.ran_at > existing.ran_at) suite[r.mode] = r;
  }
  return out;
}

export interface EvalCompareOptions {
  input?: string;
  json?: boolean;
}

export async function runEvalCompareCmd(opts: EvalCompareOptions = {}): Promise<number> {
  const path = opts.input ?? defaultResultsPath();
  const records = readResults(path);
  if (records.length === 0) {
    console.log(`No eval results found at ${path}.`);
    console.log(`Run: memrain eval run-all --modes ${SEARCH_MODES.join(",")}`);
    return 0;
  }
  const grouped = groupLatest(records);
  if (opts.json) {
    console.log(
      JSON.stringify({ ok: true, input: path, grouped, glossary: METRIC_GLOSSARY }, null, 2),
    );
    return 0;
  }
  for (const [suite, modes] of Object.entries(grouped)) {
    console.log(`Suite: ${suite}`);
    console.log(
      `  ${"mode".padEnd(14)}${"recall".padStart(8)}${"mrr".padStart(8)}${"ndcg".padStart(8)}` +
        `${"p@k".padStart(8)}${"hit%".padStart(8)}  ${"mrr ci95".padEnd(15)}  run`,
    );
    for (const mode of SEARCH_MODES) {
      const r = modes[mode];
      if (!r) {
        console.log(`  ${mode.padEnd(14)}${"—".padStart(8).repeat(5)}  ${"".padEnd(15)}  (no run)`);
        continue;
      }
      if (r.status !== "completed" || !r.metrics) {
        console.log(`  ${mode.padEnd(14)}  FAILED: ${r.error ?? "?"}`);
        continue;
      }
      console.log(
        `  ${mode.padEnd(14)}` +
          r.metrics.mean_recall.toFixed(3).padStart(8) +
          r.metrics.mean_mrr.toFixed(3).padStart(8) +
          optMetric(r.metrics.ndcg) +
          optMetric(r.metrics.precision) +
          (r.metrics.hit_rate * 100).toFixed(1).padStart(8) +
          `  ${formatCi(r.metrics.mrr_ci95).padEnd(15)}` +
          `  ${r.run_id} @ ${r.ran_at}`,
      );
    }
    console.log("");
  }
  return 0;
}

/** Records written before nDCG/P@k existed render a dash, not a zero. */
function optMetric(v: number | undefined): string {
  return (v === undefined ? "—" : v.toFixed(3)).padStart(8);
}

function formatCi(ci: Ci95 | undefined): string {
  return ci ? `[${ci.lo.toFixed(3)}–${ci.hi.toFixed(3)}]` : "—";
}

export interface EvalBaseline {
  saved_at: string;
  k: number;
  mean_recall: number;
  mean_mrr: number;
  hit_rate: number;
  /** Absent on baselines written before the paired intervals existed. */
  per_query?: Record<string, { recall: number; rr: number }>;
  qrels_sha256?: string;
  run_config_hash?: string;
  /** EVAL_SCORING_VERSION the baseline was scored under; absent means 1. */
  scoring_version?: number;
}

/**
 * The baseline the gate may judge against, or null when it was scored under
 * another formula: its means are not comparable, so the run is held to the
 * correctness floor and the baseline should be rewritten.
 */
export function comparableBaseline(baseline: EvalBaseline | null): EvalBaseline | null {
  if (!baseline) return null;
  return (baseline.scoring_version ?? 1) === EVAL_SCORING_VERSION ? baseline : null;
}

/**
 * Paired current − baseline intervals over the query ids both runs scored,
 * with the point deltas over that same subset: the verdict compares full-set
 * means, which diverge from the paired view once the qrels gain or lose ids.
 * Null for a legacy baseline without per-query scores or no shared ids.
 */
export function gateDeltaCi(
  report: Pick<EvalReport, "perQuery">,
  baseline: EvalBaseline | null,
): {
  n: number;
  scored: number;
  mean_recall_delta: number;
  mean_mrr_delta: number;
  mean_recall: Ci95;
  mean_mrr: Ci95;
} | null {
  const per = baseline?.per_query;
  if (!per) return null;
  const before = { recall: [] as number[], rr: [] as number[] };
  const after = { recall: [] as number[], rr: [] as number[] };
  for (const q of report.perQuery) {
    const b = per[q.id];
    if (!b || q.abstention) continue;
    before.recall.push(b.recall);
    before.rr.push(b.rr);
    after.recall.push(q.recallAtK);
    after.rr.push(q.mrr);
  }
  if (after.rr.length === 0) return null;
  const n = after.rr.length;
  const meanDelta = (b: number[], a: number[]) =>
    a.reduce((s, x, i) => s + x - b[i]!, 0) / n;
  return {
    n,
    scored: report.perQuery.filter((q) => !q.abstention).length,
    mean_recall_delta: meanDelta(before.recall, after.recall),
    mean_mrr_delta: meanDelta(before.rr, after.rr),
    mean_recall: deltaCi95(before.recall, after.recall),
    mean_mrr: deltaCi95(before.rr, after.rr),
  };
}

export interface EvalGateOptions {
  baseline?: string;
  maxDrop?: number;
  minRecall?: number;
  writeBaseline?: boolean;
  qrelsPath?: string;
  k?: number;
  configPath?: string;
  searchFn?: EvalOptions["searchFn"];
}

export function defaultBaselinePath(): string {
  return join(dirname(defaultConfigPath()), "eval-baseline.json");
}

/** Pure gate verdict (exported for tests). */
export function gateVerdict(
  report: Pick<EvalReport, "meanRecall" | "meanReciprocalRank">,
  baseline: EvalBaseline | null,
  maxDrop: number,
  minRecall: number,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (baseline) {
    const recallDrop = baseline.mean_recall - report.meanRecall;
    const mrrDrop = baseline.mean_mrr - report.meanReciprocalRank;
    if (recallDrop > maxDrop) {
      reasons.push(
        `meanRecall dropped ${recallDrop.toFixed(3)} vs baseline (${baseline.mean_recall.toFixed(3)} → ${report.meanRecall.toFixed(3)}, max allowed ${maxDrop})`,
      );
    }
    if (mrrDrop > maxDrop) {
      reasons.push(
        `MRR dropped ${mrrDrop.toFixed(3)} vs baseline (${baseline.mean_mrr.toFixed(3)} → ${report.meanReciprocalRank.toFixed(3)}, max allowed ${maxDrop})`,
      );
    }
  } else if (report.meanRecall < minRecall) {
    reasons.push(
      `meanRecall ${report.meanRecall.toFixed(3)} below the correctness floor ${minRecall}`,
    );
  }
  return { pass: reasons.length === 0, reasons };
}

export async function runEvalGate(opts: EvalGateOptions = {}): Promise<number> {
  const qrels = loadQrels(opts.qrelsPath ?? defaultQrelsPath());
  const maxDrop = opts.maxDrop ?? 0.05;
  const minRecall = opts.minRecall ?? 0.6;
  const baselinePath = opts.baseline ?? defaultBaselinePath();

  let baseline: EvalBaseline | null = null;
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as EvalBaseline;
    } catch (e) {
      console.error(
        `memrain eval gate: baseline at ${baselinePath} is unreadable: ${e instanceof Error ? e.message : e}`,
      );
      return 1;
    }
  }

  const storage = new Storage(loadConfig(opts.configPath));
  const report = await withStorage(storage, async () => {
    const targets = expectedTargets(qrels);
    const stale = staleQrelsReason(targets, await presentTargetPaths(storage, targets));
    if (stale) {
      console.error(stale);
      return null;
    }
    return evalRun(storage, qrels, { name: "gate" }, {
      ...(opts.k !== undefined ? { k: opts.k } : {}),
      ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
    });
  });
  if (!report) return EXIT_STALE_QRELS;

  const comparable = comparableBaseline(baseline);
  const scoringChanged = baseline !== null && comparable === null;
  if (scoringChanged) {
    console.error(
      `memrain eval gate: the baseline at ${baselinePath} was scored under scoring version ` +
        `${baseline?.scoring_version ?? 1}, this run under ${EVAL_SCORING_VERSION}; it is not ` +
        `judged against. Re-baseline with --write-baseline.`,
    );
  }
  // The interval is reported next to the verdict; it does not decide it.
  const verdict = gateVerdict(report, comparable, maxDrop, minRecall);
  const deltaCi = gateDeltaCi(report, comparable);
  const qrelsChanged =
    baseline?.qrels_sha256 !== undefined && baseline.qrels_sha256 !== report.qrels_sha256;
  if (opts.writeBaseline && verdict.pass) {
    const next: EvalBaseline = {
      saved_at: new Date().toISOString(),
      k: report.k,
      mean_recall: report.meanRecall,
      mean_mrr: report.meanReciprocalRank,
      hit_rate: report.hitRate,
      per_query: Object.fromEntries(
        report.perQuery
          .filter((q) => !q.abstention)
          .map((q) => [q.id, { recall: q.recallAtK, rr: q.mrr }]),
      ),
      qrels_sha256: report.qrels_sha256,
      run_config_hash: report.run_config_hash,
      scoring_version: EVAL_SCORING_VERSION,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  }

  console.log(
    JSON.stringify(
      {
        ok: verdict.pass,
        baseline: baseline ? baselinePath : null,
        mean_recall: report.meanRecall,
        mean_mrr: report.meanReciprocalRank,
        hit_rate: report.hitRate,
        recall_ci95: report.recallCi95,
        mrr_ci95: report.mrrCi95,
        ...(deltaCi ? { delta_ci95: deltaCi } : {}),
        ...(qrelsChanged ? { qrels_changed: true } : {}),
        ...(scoringChanged ? { scoring_changed: true, rebaseline: true } : {}),
        run_config_hash: report.run_config_hash,
        qrels_sha256: report.qrels_sha256,
        reasons: verdict.reasons,
        baseline_written: Boolean(opts.writeBaseline && verdict.pass),
        glossary: METRIC_GLOSSARY,
      },
      null,
      2,
    ),
  );
  return verdict.pass ? 0 : 1;
}
