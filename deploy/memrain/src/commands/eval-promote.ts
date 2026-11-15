/**
 * `memrain eval promote <FLAG>` — may this ranking flag become a default?
 *
 *   eval promote <FLAG> [--lme-r-base SUMMARY --lme-r SUMMARY] [--live] [--out DIR] [--json]
 *
 * One report against the acceptance protocol. On the search bench (its own
 * throwaway brain, no model spend) the baseline runs twice — their difference
 * is the noise floor, max(0.01, 2 x |run 1 - run 2|) per metric — and the flag
 * (MEMRAIN_RANK_<FLAG>=1) once. With --live the operator's labelled dev
 * queries (the admin labelling screen) run the same three times against the
 * live brain and join the paired statistics; that costs one query embedding
 * per query and run. The verdict:
 *
 *   FAIL        any metric overall drops by more than the noise; a tag with ten
 *               or more queries drops by more than 0.05; a decoy passes; a
 *               query that held its expected top-1 loses it; a query threw; the
 *               bench spent anything; or LongMemEval retrieval recall@5 falls
 *               more than one point
 *   PASS        none of that, and nDCG@10 or MRR improves by at least the noise
 *               with a Holm-adjusted paired p below 0.05, and the LongMemEval
 *               retrieval-only figures for both settings were supplied
 *   INCOMPLETE  it would pass, but the LongMemEval figures are missing
 *   NEUTRAL     nothing failed and nothing improved beyond the noise: the flag
 *               stays an opt-in
 *   REFUSED     the inputs cannot support a verdict
 *
 * --lme-r-base / --lme-r take the summary.json of two `eval longmemeval
 * --retrieval-only` runs over the same questions, the second with the flag set.
 * The report is printed and written to <config-dir>/promote/<FLAG>-<time>.json
 * (or --out DIR). The sealed split and a paid stage's lme-qa run stay separate
 * steps. Exit: 0 PASS, 1 FAIL, 2 REFUSED or bad usage, 3 NEUTRAL or INCOMPLETE.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { defaultConfigPath, loadConfig } from "../core/config.ts";
import { RANKING_FLAGS, type RankingFlag } from "../core/search/ranking-flags.ts";
import { holmAdjusted, pairedClusterStatistics, type PairedClusterStatistics } from "../core/search/bootstrap.ts";
import {
  benchRankedPaths,
  BenchUnsafeConfig,
  loadBenchQrels,
  meanScores,
  openBenchBrain,
  scoreBench,
  scoreRanked,
  type BenchMetrics,
  type BenchQrels,
  type DecoyReport,
  type QueryScore,
} from "../eval/bench/harness.ts";
import { loadLiveQrels } from "../eval/live-set.ts";
import { LME_RETRIEVAL_LABEL } from "../eval/longmemeval/harness.ts";

export type PromoteVerdict = "PASS" | "FAIL" | "NEUTRAL" | "INCOMPLETE" | "REFUSED";

export interface PromoteRun {
  per_query: Record<string, QueryScore & { tags: string[]; cluster?: string }>;
  decoys: DecoyReport;
  errors: { id: string; error: string }[];
  spend: { calls: number; usd: number };
}

type MetricKey = "hit_at_5" | "mrr" | "ndcg_at_10";
const METRICS: [MetricKey, (s: QueryScore) => number][] = [
  ["hit_at_5", (s) => s.hit5],
  ["mrr", (s) => s.rr],
  ["ndcg_at_10", (s) => s.ndcg10],
];

/** Noise floor and the per-tag tolerance from the acceptance protocol. */
export const MIN_NOISE = 0.01;
export const TAG_MIN_N = 10;
export const TAG_MAX_DROP = 0.05;
export const LME_MAX_DROP = 0.01;
export const PROMOTE_ALPHA = 0.05;

export interface PromoteInput {
  baselines: PromoteRun[];
  candidate: PromoteRun;
  /** Query ids whose first page must stay one of their expected pages. */
  top1: string[];
  /** LongMemEval retrieval-only recall@5 without and with the flag. */
  lme?: { base: number; candidate: number };
}

export interface PromoteResult {
  verdict: PromoteVerdict;
  reasons: string[];
  /** Evidence the protocol asks for that this run did not have. */
  missing: string[];
  noise: Record<MetricKey, number>;
  overall: { baseline: BenchMetrics; candidate: BenchMetrics } | null;
  paired: Record<string, PairedClusterStatistics & { p_holm: number }>;
  by_tag: Record<string, { n: number; baseline: BenchMetrics; candidate: BenchMetrics }>;
}

function metricsOf(run: PromoteRun): BenchMetrics {
  return meanScores(Object.values(run.per_query));
}

function byTag(run: PromoteRun): Record<string, QueryScore[]> {
  const out: Record<string, QueryScore[]> = {};
  for (const s of Object.values(run.per_query)) for (const t of s.tags) (out[t] ??= []).push(s);
  return out;
}

/** The pure verdict; exported for tests. */
export function promoteVerdict(input: PromoteInput): PromoteResult {
  const empty = { hit_at_5: MIN_NOISE, mrr: MIN_NOISE, ndcg_at_10: MIN_NOISE };
  if (input.baselines.length < 2) {
    return {
      verdict: "REFUSED",
      reasons: ["a second baseline run is needed: without it the noise floor cannot be measured"],
      missing: [], noise: empty, overall: null, paired: {}, by_tag: {},
    };
  }
  const [b1, b2] = [metricsOf(input.baselines[0]!), metricsOf(input.baselines[1]!)];
  const noise = Object.fromEntries(METRICS.map(([m]) => [m, Math.max(MIN_NOISE, 2 * Math.abs(b1[m] - b2[m]))])) as Record<MetricKey, number>;
  const base = input.baselines[0]!;
  const cand = input.candidate;
  const c = metricsOf(cand);
  const reasons: string[] = [];

  for (const [label, run] of [["baseline", input.baselines[0]!], ["second baseline", input.baselines[1]!], ["candidate", cand]] as const) {
    if (run.errors.length > 0) reasons.push(`${run.errors.length} quer${run.errors.length === 1 ? "y" : "ies"} threw in the ${label} run`);
    if (run.spend.calls > 0) reasons.push(`the ${label} bench run made ${run.spend.calls} paid call(s); it must spend nothing`);
    if (run.decoys.passed.length > 0) reasons.push(`the scorer accepted decoy answers (${run.decoys.passed.join(", ")}) in the ${label} run`);
  }
  for (const [m] of METRICS) {
    if (b1[m] - c[m] > noise[m]) reasons.push(`${m} fell ${(b1[m] - c[m]).toFixed(3)} overall, above the noise ${noise[m].toFixed(3)}`);
  }
  const baseTags = byTag(base);
  const candTags = byTag(cand);
  const tagReport: PromoteResult["by_tag"] = {};
  for (const [tag, scores] of Object.entries(candTags).sort(([a], [b]) => a.localeCompare(b))) {
    const before = meanScores(baseTags[tag] ?? []);
    const after = meanScores(scores);
    tagReport[tag] = { n: scores.length, baseline: before, candidate: after };
    if (scores.length < TAG_MIN_N) continue;
    for (const [m] of METRICS) {
      if (before[m] - after[m] > TAG_MAX_DROP) reasons.push(`${m} fell ${(before[m] - after[m]).toFixed(3)} on ${tag} (n=${scores.length})`);
    }
  }
  const lost = input.top1.filter((id) => base.per_query[id]?.rr === 1 && (cand.per_query[id]?.rr ?? 0) < 1);
  if (lost.length > 0) reasons.push(`expected top-1 lost for ${lost.join(", ")}`);
  if (input.lme && input.lme.base - input.lme.candidate > LME_MAX_DROP) {
    reasons.push(`LongMemEval retrieval recall@5 fell from ${input.lme.base.toFixed(3)} to ${input.lme.candidate.toFixed(3)}`);
  }

  const ids = Object.keys(base.per_query).filter((id) => cand.per_query[id] !== undefined).sort();
  const clusters = ids.map((id) => base.per_query[id]!.cluster ?? id);
  const stats = METRICS.map(([, pick]) => pairedClusterStatistics(
    ids.map((id) => pick(base.per_query[id]!)),
    ids.map((id) => pick(cand.per_query[id]!)),
    clusters,
  ));
  const holm = holmAdjusted(stats.map((s) => s.p_value));
  const paired = Object.fromEntries(METRICS.map(([m], i) => [m, { ...stats[i]!, p_holm: holm[i]! }]));
  const improved = (["ndcg_at_10", "mrr"] as const).some((m) => paired[m]!.p_holm < PROMOTE_ALPHA && paired[m]!.delta >= noise[m]);
  const missing = input.lme ? [] : ["lme-r"];
  const verdict: PromoteVerdict = reasons.length > 0 ? "FAIL" : !improved ? "NEUTRAL" : missing.length > 0 ? "INCOMPLETE" : "PASS";
  return { verdict, reasons, missing, noise, overall: { baseline: b1, candidate: c }, paired, by_tag: tagReport };
}

export interface EvalPromoteOptions {
  flag: string;
  lmeBase?: string;
  lmeCandidate?: string;
  live?: boolean;
  outDir?: string;
  json?: boolean;
  /** Print nothing (tests). */
  quiet?: boolean;
  configPath?: string;
  /** Test seam for the live search (ranked source paths for a query). */
  liveSearch?: (storage: Storage, query: string) => Promise<string[]>;
}

class Refusal extends Error {
  override name = "Refusal";
}

function readLme(path: string): { recall: number; selected: number; scored: number; dataset: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Refusal(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const s = raw as {
    label?: unknown; recall_any_at_5?: unknown; selected?: unknown; recall_scored?: unknown;
    not_run?: unknown; interrupted?: unknown; dataset?: { sha256?: unknown };
  };
  if (s.label !== LME_RETRIEVAL_LABEL || typeof s.recall_any_at_5 !== "number") {
    throw new Refusal(`${path} is not the summary of an 'eval longmemeval --retrieval-only' run`);
  }
  // A run stopped by its cap, or with interrupted questions, scored only part
  // of the set; its recall is not comparable with a complete run's.
  if (s.not_run !== 0 || !Array.isArray(s.interrupted) || s.interrupted.length > 0 || typeof s.recall_scored !== "number" || s.recall_scored < 1) {
    throw new Refusal(`${path} is from an incomplete run (questions not run or interrupted); finish or resume it first`);
  }
  return { recall: s.recall_any_at_5, selected: Number(s.selected ?? 0), scored: s.recall_scored, dataset: String(s.dataset?.sha256 ?? "") };
}

const envFor = (flag: RankingFlag, on: boolean) => ({ [`MEMRAIN_RANK_${flag}`]: on ? "1" : "0" });

async function liveRun(
  storage: Storage,
  qrels: BenchQrels,
  env: Record<string, string>,
  search: (storage: Storage, query: string) => Promise<string[]>,
): Promise<PromoteRun> {
  const per: PromoteRun["per_query"] = {};
  const errors: PromoteRun["errors"] = [];
  for (const q of qrels.queries) {
    const prev = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      per[q.id] = { ...scoreRanked(await search(storage, q.query), q), tags: q.tags.map((t) => `live:${t}`) };
    } catch (e) {
      errors.push({ id: q.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  return { per_query: per, decoys: { total: 0, passed: [] }, errors, spend: { calls: 0, usd: 0 } };
}

function merge(a: PromoteRun, b: PromoteRun | null): PromoteRun {
  if (!b) return a;
  return {
    per_query: { ...a.per_query, ...b.per_query },
    decoys: a.decoys,
    errors: [...a.errors, ...b.errors],
    spend: a.spend,
  };
}

export async function runEvalPromote(opts: EvalPromoteOptions): Promise<number> {
  const say = (line: string) => {
    if (!opts.quiet) console.error(`memrain eval promote: ${line}`);
  };
  const flag = opts.flag.trim().toUpperCase().replace(/^MEMRAIN_RANK_/, "") as RankingFlag;
  if (!RANKING_FLAGS.includes(flag)) {
    say(`unknown ranking flag '${opts.flag}' (${RANKING_FLAGS.join("|")})`);
    return 2;
  }
  if ((opts.lmeBase === undefined) !== (opts.lmeCandidate === undefined)) {
    say("--lme-r-base and --lme-r go together");
    return 2;
  }
  try {
    let lme: { base: number; candidate: number } | undefined;
    if (opts.lmeBase && opts.lmeCandidate) {
      const [b, c] = [readLme(opts.lmeBase), readLme(opts.lmeCandidate)];
      if (b.selected !== c.selected || b.scored !== c.scored || b.dataset !== c.dataset) {
        throw new Refusal("the two LongMemEval summaries cover different questions or datasets");
      }
      lme = { base: b.recall, candidate: c.recall };
    }
    const qrels = loadBenchQrels();
    const brain = await openBenchBrain();
    let runs: PromoteRun[];
    try {
      runs = [];
      for (const on of [false, false, true]) runs.push(await scoreBench(brain, qrels, { env: envFor(flag, on) }));
    } finally {
      await brain.close();
    }
    let live: PromoteRun[] | null = null;
    if (opts.live) {
      const storage = new Storage(loadConfig(opts.configPath));
      live = await withStorage(storage, async () => {
        const liveQrels = await loadLiveQrels(storage.engine());
        if (liveQrels.queries.length === 0) throw new Refusal("--live: no labelled dev queries yet; label some on the admin Labelling page");
        const search = opts.liveSearch ?? ((s: Storage, q: string) => benchRankedPaths(s, q, undefined, true));
        const out: PromoteRun[] = [];
        for (const on of [false, false, true]) out.push(await liveRun(storage, liveQrels, envFor(flag, on), search));
        return out;
      });
    }
    const top1 = qrels.queries.filter((q) => q.expected_top1 && q.decoy_output === undefined).map((q) => q.id);
    const result = promoteVerdict({
      baselines: [merge(runs[0]!, live?.[0] ?? null), merge(runs[1]!, live?.[1] ?? null)],
      candidate: merge(runs[2]!, live?.[2] ?? null),
      top1,
      ...(lme ? { lme } : {}),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = opts.outDir ?? join(dirname(defaultConfigPath()), "promote");
    const path = join(dir, `${flag}-${stamp}.json`);
    const report = {
      flag,
      env: `MEMRAIN_RANK_${flag}=1`,
      ...result,
      sets: live ? ["bench", "live"] : ["bench"],
      lme: lme ?? null,
      decoys_line: `DECOYS: ${runs[2]!.decoys.passed.length}/${runs[2]!.decoys.total} passed`,
      spend: runs.reduce((acc, r) => ({ calls: acc.calls + r.spend.calls, usd: acc.usd + r.spend.usd }), { calls: 0, usd: 0 }),
      qrels_sha256: qrels.sha256,
      written_at: new Date().toISOString(),
      written: path,
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (!opts.quiet) console.log(JSON.stringify(opts.json ? report : { ...report, by_tag: undefined }, null, 2));
    return result.verdict === "PASS" ? 0 : result.verdict === "FAIL" ? 1 : result.verdict === "REFUSED" ? 2 : 3;
  } catch (e) {
    if (e instanceof Refusal || e instanceof BenchUnsafeConfig) {
      say(e.message);
      return 2;
    }
    throw e;
  }
}
