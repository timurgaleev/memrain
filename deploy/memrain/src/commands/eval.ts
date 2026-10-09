/**
 * `memrain eval` — retrieval quality harness.
 *
 * Reads tests/eval/qrels.json (curated ground-truth: query → expected
 * source_paths), runs each query through hybridSearch, computes
 * Recall@k, MRR, nDCG@k and P@k with seeded bootstrap intervals, and prints
 * a report fingerprinted by a run-config hash and the qrels checksum.
 *
 * Config-vs-config instrumentation:
 *   memrain eval [--rrf-k N] [--expand|--no-expand] [--rerank] [--max-pool]
 *              [--graph-signals] [--cosine-rescore] [--relational-arm]
 *              [--dedup-type-ratio X] [--qrels PATH] [--k N]
 *   memrain eval --config-a '<json|path>' --config-b '<json|path>'
 *              A/B: run both knob sets over the same qrels, print the delta.
 *
 * Eval queries always bypass the query cache — the metric must measure
 * retrieval, not cache reuse.
 *
 * No mocking — runs against the live brain so the metric reflects
 * production behaviour. That makes this command Bedrock-billable;
 * keep `qrels.json` small.
 *
 * Recall, MRR, nDCG and P@k score distinct pages: two chunks of one page are
 * one hit. Queries with no expected paths are abstention checks — they stay out
 * of every average and are reported on their own as a false-positive rate.
 *
 * Exit code (single-run mode): 0 if average recall@5 >= MIN_RECALL
 * (default 0.6), else 1. Suitable as a CI gate. Exit 2, before any query
 * runs, when more than half of the qrels' expected paths are missing from
 * the brain: stale ground truth would read as a retrieval regression.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { hybridSearch } from "../core/search/index.ts";
import { resolveSearchKnobs } from "../core/search/hybrid.ts";
import { DEFAULT_RRF_K } from "../core/rrf.ts";
import { embeddingSignature } from "../core/embedding.ts";
import { wilsonCI, smallSampleNote, type WilsonCI } from "../core/wilson.ts";
import {
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  binaryGrades,
  distinctInOrder,
} from "../core/search/metrics.ts";
import { ci95, METRIC_GLOSSARY, type Ci95 } from "../core/search/bootstrap.ts";

export interface Qrel {
  id: string;
  query: string;
  expected_paths: string[];
  notes?: string;
}
export interface Qrels {
  queries: Qrel[];
  /** sha256 of the qrels file bytes; set by loadQrels. */
  sha256?: string;
}

export interface QueryReport {
  id: string;
  query: string;
  recallAtK: number;
  mrr: number;
  ndcg: number;
  precision: number;
  hits: number;
  expected: number;
  topPaths: string[];
  /** Set when this query threw — the run continues, the query scores 0. */
  error?: string;
  /** No expected paths: the right answer is "nothing relevant". Scored in the
   *  report's `abstention` block, never in the recall/MRR averages. */
  abstention?: boolean;
}

export interface AbstentionReport {
  /** Queries whose qrels list no expected path. */
  count: number;
  /** Of those, how many came back with at least one hit. */
  returnedAny: number;
  /** returnedAny / count, or null when there are no abstention queries. */
  falsePositiveRate: number | null;
}

export interface EvalReport {
  ok: boolean;
  k: number;
  configName: string;
  meanRecall: number;
  meanReciprocalRank: number;
  meanNdcg: number;
  meanPrecision: number;
  recallCi95: Ci95;
  mrrCi95: Ci95;
  /** Fingerprint of knobs + k + qrels: two runs compare like for like only
   *  when this matches. */
  run_config_hash: string;
  qrels_sha256: string;
  /** Fraction of queries that retrieved at least one expected path (a binomial
   *  proportion the Wilson CI bounds). */
  hitRate: number;
  wilsonCi95: WilsonCI;
  /** Present when n < 30 — the CI is too wide to act on. */
  smallSampleNote?: string;
  /** Queries with expected paths: the n behind every mean and interval above. */
  scoredQueries: number;
  abstention: AbstentionReport;
  /** Queries that threw (isolated, did not abort the run). */
  errors: { id: string; error: string }[];
  perQuery: QueryReport[];
}

/**
 * One ranking-knob set for an eval run. Maps 1:1 onto hybridSearch per-call
 * options; `dedupTypeRatio` is env-plane (MEMRAIN_MAX_TYPE_RATIO) and is
 * wrapped around the run.
 */
export interface EvalKnobConfig {
  name?: string;
  k?: number;
  rrfK?: number;
  expansion?: boolean;
  rerank?: boolean;
  maxPool?: boolean;
  graphSignals?: boolean;
  cosineRescore?: boolean;
  relationalArm?: boolean;
  backlinkBoost?: boolean;
  tokenBudget?: number;
  dedupTypeRatio?: number;
}

/** Parse a knob config from inline JSON or a file path. */
export function parseEvalConfig(pathOrJson: string): EvalKnobConfig {
  const trimmed = pathOrJson.trimStart();
  const raw =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? pathOrJson
      : readFileSync(pathOrJson, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("eval config must be a JSON object");
  }
  return parsed as EvalKnobConfig;
}

export interface EvalOptions {
  /** Override path to the qrels file. Defaults to tests/eval/qrels.json. */
  qrelsPath?: string;
  /** k for Recall@k. Default 5. */
  k?: number;
  /** Min average recall@k below which we exit non-zero. Default 0.6. */
  minRecall?: number;
  /** Knob set for the (single or A-side) run. */
  config?: EvalKnobConfig;
  /** B-side knob set — presence turns on A/B comparison mode. */
  configB?: EvalKnobConfig;
  /** Test seam — replaces the live hybridSearch call; returns ranked paths. */
  searchFn?: (
    storage: Storage,
    query: string,
    cfg: EvalKnobConfig,
    k: number,
  ) => Promise<string[]>;
  configPath?: string;
}

export function defaultQrelsPath(): string {
  // Resolve relative to the source file location — the harness ships in
  // the same package as the qrels and the tests dir is alongside src/.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../tests/eval/qrels.json");
}

export function loadQrels(qrelsPath: string): Qrels {
  if (!existsSync(qrelsPath)) {
    throw new Error(`memrain eval: qrels file not found at ${qrelsPath}`);
  }
  const bytes = readFileSync(qrelsPath);
  const qrels = JSON.parse(bytes.toString("utf8")) as Qrels;
  if (!qrels.queries || qrels.queries.length === 0) {
    throw new Error(`memrain eval: no queries in ${qrelsPath}`);
  }
  return { ...qrels, sha256: sha256Hex(bytes) };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted at every level, so key order never moves a hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Ranking env knobs hybridSearch reads that `resolveSearchKnobs` does not
 * already fold in. Budgets, timeouts and cache settings are left out: they
 * bound cost or latency, and eval runs with the cache off.
 */
const RANKING_ENV_KNOBS = [
  "MEMRAIN_ALIAS_HOP",
  "MEMRAIN_CURATION_BOOST",
  "MEMRAIN_EMBED_DIM",
  "MEMRAIN_GRAPH_RERANK",
  "MEMRAIN_GRAPH_SIGNALS_FLOOR",
  "MEMRAIN_INTENT_LLM",
  "MEMRAIN_MAX_TYPE_RATIO",
  "MEMRAIN_NEARDUP_JACCARD",
  "MEMRAIN_RECENCY_BOOST",
  "MEMRAIN_RECENCY_DECAY",
  "MEMRAIN_RELATIONAL_ARM_WEIGHT",
  "MEMRAIN_RELATIONAL_LLM",
  "MEMRAIN_RERANK_WINDOW",
  "MEMRAIN_SEARCH_EXCLUDE",
  "MEMRAIN_TITLE_BOOST",
  "MEMRAIN_UTILITY_MODEL",
] as const;

/**
 * Run fingerprint over what the search actually runs with: the knobs as
 * hybridSearch resolves them (explicit config, then MEMRAIN_* env, then the
 * search-mode bundle), so the same effective setup hashes the same whether it
 * was spelled out or defaulted; plus the raw ranking env knobs, the embedding
 * signature, k and the qrels checksum. The display name is excluded, and so
 * is the corpus: eval runs against the live brain.
 */
export function runConfigHash(
  cfg: EvalKnobConfig,
  k: number,
  qrelsSha256: string,
): string {
  const env = process.env;
  const resolved = resolveSearchKnobs({
    ...(cfg.expansion !== undefined ? { expansion: cfg.expansion } : {}),
    ...(cfg.rerank !== undefined ? { rerank: cfg.rerank } : {}),
    ...(cfg.graphSignals !== undefined ? { graphSignals: cfg.graphSignals } : {}),
    ...(cfg.cosineRescore !== undefined ? { cosineRescore: cfg.cosineRescore } : {}),
    ...(cfg.relationalArm !== undefined ? { relationalArm: cfg.relationalArm } : {}),
    ...(cfg.backlinkBoost !== undefined ? { backlinkBoost: cfg.backlinkBoost } : {}),
    ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
  });
  const envKnobs: Record<string, string | undefined> = {};
  for (const key of RANKING_ENV_KNOBS) envKnobs[key] = env[key];
  // evalRun applies dedupTypeRatio through the env for the run's duration.
  if (cfg.dedupTypeRatio !== undefined) {
    envKnobs["MEMRAIN_MAX_TYPE_RATIO"] = String(cfg.dedupTypeRatio);
  }
  return sha256Hex(
    canonicalJson({
      knobs: {
        ...resolved,
        rrfK: cfg.rrfK ?? DEFAULT_RRF_K,
        maxPool: cfg.maxPool ?? env.MEMRAIN_MAXPOOL === "1",
      },
      env: envKnobs,
      embedding: embeddingSignature(),
      k,
      qrels_sha256: qrelsSha256,
    }),
  );
}

/** Above this share of expected paths missing from the brain, a run would
 *  measure the qrels' age, not retrieval, so eval refuses to score it. */
export const MAX_ABSENT_TARGET_RATIO = 0.5;

/** Exit code for a refused run (qrels no longer match the brain). */
export const EXIT_STALE_QRELS = 2;

/** Distinct expected paths across the qrels, in first-seen order. */
export function expectedTargets(qrels: Qrels): string[] {
  return distinctInOrder(qrels.queries.flatMap((q) => q.expected_paths));
}

/** The subset of `paths` held by a live (not soft-deleted) document. */
export async function presentTargetPaths(
  storage: Storage,
  paths: string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const r = await storage.engine().query<{ source_path: string }>(
    `SELECT DISTINCT source_path FROM documents
      WHERE source_path = ANY($1::text[]) AND deleted_at IS NULL`,
    [paths],
  );
  return new Set(r.rows.map((row) => row.source_path));
}

/**
 * Why the qrels cannot be scored against this brain, or null when they can:
 * more than {@link MAX_ABSENT_TARGET_RATIO} of the expected paths are gone, so
 * recall would fall for reasons retrieval has no part in.
 */
export function staleQrelsReason(targets: string[], present: ReadonlySet<string>): string | null {
  if (targets.length === 0) return null;
  const absent = targets.filter((p) => !present.has(p));
  if (absent.length / targets.length <= MAX_ABSENT_TARGET_RATIO) return null;
  const sample = absent.slice(0, 5).join(", ");
  return (
    `memrain eval: ${absent.length} of ${targets.length} expected paths in the qrels ` +
    `are not in this brain (e.g. ${sample}${absent.length > 5 ? ", ..." : ""}). ` +
    `The ground truth no longer matches the corpus; update the qrels before scoring.`
  );
}

/**
 * How metrics are computed. A baseline scored under another version is not
 * comparable even when the run config and qrels hashes match. 2: page-level
 * dedup, abstention queries outside the averages.
 */
export const EVAL_SCORING_VERSION = 2;

/** hybridSearch's k counts chunks; fetch this many times k so that k distinct
 *  pages usually remain after page dedup. */
const PAGE_OVERFETCH = 3;

async function defaultSearchFn(
  storage: Storage,
  query: string,
  cfg: EvalKnobConfig,
  k: number,
): Promise<string[]> {
  const hits = await hybridSearch(storage, query, {
    k: k * PAGE_OVERFETCH,
    noCache: true,
    ...(cfg.rrfK !== undefined ? { rrfK: cfg.rrfK } : {}),
    ...(cfg.expansion !== undefined ? { expansion: cfg.expansion } : {}),
    ...(cfg.rerank !== undefined ? { rerank: cfg.rerank } : {}),
    ...(cfg.maxPool !== undefined ? { maxPool: cfg.maxPool } : {}),
    ...(cfg.graphSignals !== undefined ? { graphSignals: cfg.graphSignals } : {}),
    ...(cfg.cosineRescore !== undefined ? { cosineRescore: cfg.cosineRescore } : {}),
    ...(cfg.relationalArm !== undefined ? { relationalArm: cfg.relationalArm } : {}),
    ...(cfg.backlinkBoost !== undefined ? { backlinkBoost: cfg.backlinkBoost } : {}),
    ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
  });
  return distinctInOrder(hits.map((h) => h.sourcePath)).slice(0, k);
}

/**
 * Run one knob config over the qrels set. Per-query isolation: one query
 * throwing must not abort the run. `dedupTypeRatio` is applied by wrapping
 * MEMRAIN_MAX_TYPE_RATIO for the duration (the knob is env-resolved per call).
 */
export async function evalRun(
  storage: Storage,
  qrels: Qrels,
  cfg: EvalKnobConfig,
  opts: { k?: number; searchFn?: EvalOptions["searchFn"] } = {},
): Promise<EvalReport> {
  const k = opts.k ?? cfg.k ?? 5;
  const searchFn = opts.searchFn ?? defaultSearchFn;

  const prevRatio = process.env["MEMRAIN_MAX_TYPE_RATIO"];
  if (cfg.dedupTypeRatio !== undefined) {
    process.env["MEMRAIN_MAX_TYPE_RATIO"] = String(cfg.dedupTypeRatio);
  }
  const perQuery: QueryReport[] = [];
  const errors: { id: string; error: string }[] = [];
  try {
    for (const q of qrels.queries) {
      const abstention = q.expected_paths.length === 0;
      try {
        // Several chunks of one page are one hit: score pages, in rank order.
        const paths = distinctInOrder(await searchFn(storage, q.query, cfg, k));
        const expected = new Set(q.expected_paths);
        perQuery.push({
          id: q.id,
          query: q.query,
          recallAtK: recallAtK(paths, expected, k),
          mrr: reciprocalRank(paths, expected),
          ndcg: ndcgAtK(paths, binaryGrades(q.expected_paths), k),
          precision: precisionAtK(paths, expected, k),
          hits: paths.length,
          expected: q.expected_paths.length,
          topPaths: paths.slice(0, 3),
          ...(abstention ? { abstention } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: q.id, error: msg });
        perQuery.push({
          id: q.id,
          query: q.query,
          recallAtK: 0,
          mrr: 0,
          ndcg: 0,
          precision: 0,
          hits: 0,
          expected: q.expected_paths.length,
          topPaths: [],
          error: msg,
          ...(abstention ? { abstention } : {}),
        });
      }
    }
  } finally {
    if (cfg.dedupTypeRatio !== undefined) {
      if (prevRatio === undefined) delete process.env["MEMRAIN_MAX_TYPE_RATIO"];
      else process.env["MEMRAIN_MAX_TYPE_RATIO"] = prevRatio;
    }
  }

  // Abstention queries have nothing to recall; averaging them in at any fixed
  // score would move the means without measuring retrieval.
  const scored = perQuery.filter((q) => !q.abstention);
  const abstentions = perQuery.filter((q) => q.abstention);
  const n = scored.length;
  const mean = (pick: (q: QueryReport) => number): number =>
    n === 0 ? 0 : scored.reduce((s, q) => s + pick(q), 0) / n;
  const meanRecall = mean((q) => q.recallAtK);
  const meanReciprocalRank = mean((q) => q.mrr);
  const meanNdcg = mean((q) => q.ndcg);
  const meanPrecision = mean((q) => q.precision);
  const qrelsSha256 = qrels.sha256 ?? sha256Hex(canonicalJson({ queries: qrels.queries }));
  // Hit-rate: fraction of queries that retrieved at least one expected path.
  // A binomial proportion — bound it with a Wilson 95% CI so the score reads
  // as a measurement with uncertainty, not a bare number.
  const hitCount = scored.filter((q) => q.recallAtK > 0).length;
  const hitRate = n === 0 ? 0 : hitCount / n;
  const wilsonCi95 = wilsonCI(hitCount, n);
  const note = smallSampleNote(n);
  // No score threshold exists to tell a confident hit from a stray one, so a
  // false positive here is any hit at all for a question with no answer.
  const returnedAny = abstentions.filter((q) => !q.error && q.hits > 0).length;
  const abstention: AbstentionReport = {
    count: abstentions.length,
    returnedAny,
    falsePositiveRate: abstentions.length === 0 ? null : returnedAny / abstentions.length,
  };

  return {
    ok: true,
    k,
    configName: cfg.name ?? "default",
    meanRecall,
    meanReciprocalRank,
    meanNdcg,
    meanPrecision,
    recallCi95: ci95(scored.map((q) => q.recallAtK)),
    mrrCi95: ci95(scored.map((q) => q.mrr)),
    run_config_hash: runConfigHash(cfg, k, qrelsSha256),
    qrels_sha256: qrelsSha256,
    hitRate,
    wilsonCi95,
    ...(note ? { smallSampleNote: note } : {}),
    scoredQueries: n,
    abstention,
    errors,
    perQuery,
  };
}

export async function runEval(opts: EvalOptions = {}): Promise<void> {
  const qrels = loadQrels(opts.qrelsPath ?? defaultQrelsPath());
  const k = opts.k ?? 5;
  const minRecall = opts.minRecall ?? 0.6;
  const cfgA: EvalKnobConfig = { name: "Config A", ...(opts.config ?? {}) };

  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const targets = expectedTargets(qrels);
    const stale = staleQrelsReason(targets, await presentTargetPaths(storage, targets));
    if (stale) {
      console.error(stale);
      process.exitCode = EXIT_STALE_QRELS;
      return;
    }
    if (opts.configB) {
      const cfgB: EvalKnobConfig = { name: "Config B", ...opts.configB };
      const evalOpts = { k, ...(opts.searchFn ? { searchFn: opts.searchFn } : {}) };
      const a = await evalRun(storage, qrels, cfgA, evalOpts);
      const b = await evalRun(storage, qrels, cfgB, evalOpts);
      const delta = {
        meanRecall: b.meanRecall - a.meanRecall,
        meanReciprocalRank: b.meanReciprocalRank - a.meanReciprocalRank,
        hitRate: b.hitRate - a.hitRate,
      };
      console.log(
        JSON.stringify({ ok: true, mode: "ab", k, a, b, delta, glossary: METRIC_GLOSSARY }, null, 2),
      );
      return;
    }

    const report = await evalRun(storage, qrels, cfgA, {
      k,
      ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
    });
    const ok = report.meanRecall >= minRecall;
    console.log(JSON.stringify({ ...report, ok, glossary: METRIC_GLOSSARY }, null, 2));
    if (!ok) process.exitCode = 1;
  });
}
