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
 *              [--split dev|sealed|all] [--prereg PATH] [--record]
 *              A/B: run both knob sets over the same qrels, interleaved per
 *              query, and print paired statistics per metric. A config's
 *              `env` map is applied around each of its queries, so a
 *              MEMRAIN_RANK_* flag can be flipped for one side only.
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
 * The sealed split is scored once per pre-registration: it runs only as a
 * recorded A/B under --prereg, and a second run under the same prereg is
 * refused, so the held-out queries cannot be tuned against.
 *
 * Exit code (single-run mode): 0 if average recall@5 >= MIN_RECALL
 * (default 0.6), else 1. Suitable as a CI gate. A/B mode exits 1 when a query
 * threw on either side. Exit 2, before any query runs, when more than half of
 * the qrels' expected paths are missing from the brain: stale ground truth
 * would read as a retrieval regression.
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
import {
  ci95,
  holmAdjusted,
  pairedClusterStatistics,
  METRIC_GLOSSARY,
  type Ci95,
  type PairedClusterStatistics,
} from "../core/search/bootstrap.ts";
import { RANKING_FLAG_ENV } from "../core/search/ranking-flags.ts";
import { recordAbSnapshot, sealedRunRecorded } from "../core/eval-snapshot.ts";

export type QrelSplit = "dev" | "sealed";
export type EvalSplit = QrelSplit | "all";

export interface Qrel {
  id: string;
  query: string;
  expected_paths: string[];
  notes?: string;
  /** Unlabelled queries belong to dev; sealed ones must say so. */
  split?: QrelSplit;
  /** Queries that share a cluster move together in the paired statistics. */
  cluster?: string;
  /** The first page returned must be one of expected_paths. */
  expected_top1?: true;
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
  /** Wall time of the search call; absent when the query threw. */
  latencyMs?: number;
  /** Set for a qrel marked expected_top1. */
  expectedTop1?: true;
  /** An expected_top1 query whose first page was not an expected one. */
  top1Miss?: true;
}

export interface AbstentionReport {
  /** Queries whose qrels list no expected path. */
  count: number;
  /** Of those, how many came back with at least one hit. */
  returnedAny: number;
  /** returnedAny / count, or null when there are no abstention queries. */
  falsePositiveRate: number | null;
}

export interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
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
  /** Search wall time over the queries that did not throw. */
  latency: LatencySummary;
  /** expected_top1 queries, and the ids among them that missed. */
  expectedTop1: { count: number; misses: string[] };
  split: EvalSplit;
  perQuery: QueryReport[];
}

/**
 * One ranking-knob set for an eval run. Maps 1:1 onto hybridSearch per-call
 * options; `dedupTypeRatio` (MEMRAIN_MAX_TYPE_RATIO) and `env` are env-plane
 * and are applied around each query, then restored.
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
  /** MEMRAIN_* variables set for this config's queries only. */
  env?: Record<string, string>;
}

const ENV_KEY = /^MEMRAIN_[A-Z0-9_]+$/;

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
  const env = (parsed as { env?: unknown }).env;
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new Error("eval config: env must be an object of MEMRAIN_* strings");
    }
    for (const [key, value] of Object.entries(env)) {
      // Only the brain's own settings: an eval config is no place to change
      // credentials or process-wide variables.
      if (!ENV_KEY.test(key) || typeof value !== "string") {
        throw new Error(
          `eval config: env entry ${key} must be a MEMRAIN_* name with a string value`,
        );
      }
    }
  }
  return parsed as EvalKnobConfig;
}

/** The env-plane part of a config, as variables to set. */
function knobEnv(cfg: EvalKnobConfig): Record<string, string> {
  return {
    ...(cfg.env ?? {}),
    ...(cfg.dedupTypeRatio !== undefined
      ? { MEMRAIN_MAX_TYPE_RATIO: String(cfg.dedupTypeRatio) }
      : {}),
  };
}

/** Set `overrides` in process.env; the returned function puts every key back. */
function applyEnv(overrides: Record<string, string>): () => void {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prev.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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
  /** Which qrels to score. Default all. */
  split?: EvalSplit;
  /** Pre-registration the run is judged under; required for the sealed split. */
  preregPath?: string;
  /** Append the A/B result to eval_snapshots as a kind 'ab' row. */
  record?: boolean;
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
  for (const q of qrels.queries) {
    if (q.split !== undefined && q.split !== "dev" && q.split !== "sealed") {
      throw new Error(`memrain eval: query ${q.id} has split '${String(q.split)}' (dev|sealed)`);
    }
  }
  return { ...qrels, sha256: sha256Hex(bytes) };
}

/** The queries of one split; the checksum stays the file's. */
export function filterSplit(qrels: Qrels, split: EvalSplit): Qrels {
  if (split === "all") return qrels;
  const queries = qrels.queries.filter((q) => (q.split ?? "dev") === split);
  if (queries.length === 0) {
    throw new Error(`memrain eval: the qrels hold no ${split} queries`);
  }
  return { ...qrels, queries };
}

/** sha256 of the sorted query ids, so a receipt pins exactly which ran. */
export function idsSha256(qrels: Qrels): string {
  return sha256Hex(qrels.queries.map((q) => q.id).sort().join("\n"));
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
const RANKING_ENV_KNOBS: readonly string[] = [
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
  ...RANKING_FLAG_ENV,
];

/**
 * Run fingerprint over what the search actually runs with: the knobs as
 * hybridSearch resolves them (explicit config, then MEMRAIN_* env, then the
 * search-mode bundle), so the same effective setup hashes the same whether it
 * was spelled out or defaulted; plus the raw ranking env knobs, the embedding
 * signature, k, the qrels checksum and the split. The display name is
 * excluded, and so is the corpus: eval runs against the live brain. A
 * config's env overrides are applied while the hash is taken, exactly as
 * they are around its queries.
 */
export function runConfigHash(
  cfg: EvalKnobConfig,
  k: number,
  qrelsSha256: string,
  split: EvalSplit = "all",
): string {
  const restore = applyEnv(knobEnv(cfg));
  try {
    return hashUnderCurrentEnv(cfg, k, qrelsSha256, split);
  } finally {
    restore();
  }
}

function hashUnderCurrentEnv(
  cfg: EvalKnobConfig,
  k: number,
  qrelsSha256: string,
  split: EvalSplit,
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
  // An override outside the known knobs still changes the run.
  const extraEnv = Object.fromEntries(
    Object.entries(cfg.env ?? {}).filter(([key]) => !RANKING_ENV_KNOBS.includes(key)),
  );
  return sha256Hex(
    canonicalJson({
      knobs: {
        ...resolved,
        rrfK: cfg.rrfK ?? DEFAULT_RRF_K,
        maxPool: cfg.maxPool ?? env.MEMRAIN_MAXPOOL === "1",
      },
      env: envKnobs,
      ...(Object.keys(extraEnv).length > 0 ? { env_extra: extraEnv } : {}),
      embedding: embeddingSignature(),
      k,
      qrels_sha256: qrelsSha256,
      ...(split !== "all" ? { split } : {}),
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

type SearchFn = NonNullable<EvalOptions["searchFn"]>;

/**
 * Score one query under one config. A throw is caught and scored 0, so one
 * query cannot abort the run. The config's env overrides are set for this call
 * only: an A/B interleaves both sides in one process.
 */
async function scoreQuery(
  storage: Storage,
  q: Qrel,
  cfg: EvalKnobConfig,
  k: number,
  searchFn: SearchFn,
): Promise<QueryReport> {
  const abstention = q.expected_paths.length === 0;
  const top1 = q.expected_top1 === true && !abstention;
  const restore = applyEnv(knobEnv(cfg));
  try {
    const started = performance.now();
    // Several chunks of one page are one hit: score pages, in rank order.
    const paths = distinctInOrder(await searchFn(storage, q.query, cfg, k));
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const expected = new Set(q.expected_paths);
    return {
      id: q.id,
      query: q.query,
      recallAtK: recallAtK(paths, expected, k),
      mrr: reciprocalRank(paths, expected),
      ndcg: ndcgAtK(paths, binaryGrades(q.expected_paths), k),
      precision: precisionAtK(paths, expected, k),
      hits: paths.length,
      expected: q.expected_paths.length,
      topPaths: paths.slice(0, 3),
      latencyMs,
      ...(abstention ? { abstention } : {}),
      ...(top1 ? { expectedTop1: true as const } : {}),
      ...(top1 && !(paths[0] !== undefined && expected.has(paths[0]))
        ? { top1Miss: true as const }
        : {}),
    };
  } catch (e) {
    return {
      id: q.id,
      query: q.query,
      recallAtK: 0,
      mrr: 0,
      ndcg: 0,
      precision: 0,
      hits: 0,
      expected: q.expected_paths.length,
      topPaths: [],
      error: e instanceof Error ? e.message : String(e),
      ...(abstention ? { abstention } : {}),
      ...(top1 ? { expectedTop1: true as const, top1Miss: true as const } : {}),
    };
  } finally {
    restore();
  }
}

/** Nearest-rank percentile; 0 for an empty sample. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function summarizeLatency(perQuery: readonly QueryReport[]): LatencySummary {
  const ms = perQuery
    .map((q) => q.latencyMs)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  return { p50Ms: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95) };
}

function summarize(
  perQuery: QueryReport[],
  qrels: Qrels,
  cfg: EvalKnobConfig,
  k: number,
  split: EvalSplit,
): EvalReport {
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
  const top1 = perQuery.filter((q) => q.expectedTop1);

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
    run_config_hash: runConfigHash(cfg, k, qrelsSha256, split),
    qrels_sha256: qrelsSha256,
    hitRate,
    wilsonCi95,
    ...(note ? { smallSampleNote: note } : {}),
    scoredQueries: n,
    abstention,
    errors: perQuery
      .filter((q) => q.error !== undefined)
      .map((q) => ({ id: q.id, error: q.error! })),
    latency: summarizeLatency(perQuery),
    expectedTop1: {
      count: top1.length,
      misses: top1.filter((q) => q.top1Miss).map((q) => q.id),
    },
    split,
    perQuery,
  };
}

/**
 * Run one knob config over the qrels set. Per-query isolation: one query
 * throwing must not abort the run.
 */
export async function evalRun(
  storage: Storage,
  qrels: Qrels,
  cfg: EvalKnobConfig,
  opts: { k?: number; searchFn?: EvalOptions["searchFn"]; split?: EvalSplit } = {},
): Promise<EvalReport> {
  const k = opts.k ?? cfg.k ?? 5;
  const searchFn = opts.searchFn ?? defaultSearchFn;
  const perQuery: QueryReport[] = [];
  for (const q of qrels.queries) perQuery.push(await scoreQuery(storage, q, cfg, k, searchFn));
  return summarize(perQuery, qrels, cfg, k, opts.split ?? "all");
}

/**
 * Run two configs over the same qrels, alternating which side goes first per
 * query, so drift in the brain or in Bedrock latency during the run falls on
 * both sides alike instead of on whichever ran second.
 */
export async function evalAB(
  storage: Storage,
  qrels: Qrels,
  cfgA: EvalKnobConfig,
  cfgB: EvalKnobConfig,
  opts: { k?: number; searchFn?: EvalOptions["searchFn"]; split?: EvalSplit } = {},
): Promise<{ a: EvalReport; b: EvalReport }> {
  const k = opts.k ?? 5;
  const searchFn = opts.searchFn ?? defaultSearchFn;
  const perA: QueryReport[] = [];
  const perB: QueryReport[] = [];
  for (const [i, q] of qrels.queries.entries()) {
    if (i % 2 === 0) {
      perA.push(await scoreQuery(storage, q, cfgA, k, searchFn));
      perB.push(await scoreQuery(storage, q, cfgB, k, searchFn));
    } else {
      perB.push(await scoreQuery(storage, q, cfgB, k, searchFn));
      perA.push(await scoreQuery(storage, q, cfgA, k, searchFn));
    }
  }
  const split = opts.split ?? "all";
  return {
    a: summarize(perA, qrels, cfgA, k, split),
    b: summarize(perB, qrels, cfgB, k, split),
  };
}

export interface AbMetricStatistics extends PairedClusterStatistics {
  /** p_value after Holm adjustment across the metrics of this comparison. */
  p_holm: number;
}

export type PairedComparison =
  | { aggregate_only: false; paired: number; metrics: Record<string, AbMetricStatistics> }
  | { aggregate_only: true; paired: number; unpaired: string[] };

/**
 * Per-metric paired statistics for B − A over the scored queries. A query that
 * threw on either side has no pair; with any such query the comparison falls
 * back to the aggregate means, since dropping it would bias the pairs toward
 * the queries both sides could answer.
 */
export function pairedComparison(a: EvalReport, b: EvalReport, qrels: Qrels): PairedComparison {
  const clusterOf = new Map(qrels.queries.map((q) => [q.id, q.cluster ?? q.id]));
  const bById = new Map(b.perQuery.map((q) => [q.id, q]));
  const pairs: { a: QueryReport; b: QueryReport }[] = [];
  const unpaired: string[] = [];
  for (const qa of a.perQuery) {
    if (qa.abstention) continue;
    const qb = bById.get(qa.id);
    if (!qb || qa.error !== undefined || qb.error !== undefined) unpaired.push(qa.id);
    else pairs.push({ a: qa, b: qb });
  }
  if (unpaired.length > 0 || pairs.length === 0) {
    return { aggregate_only: true, paired: pairs.length, unpaired };
  }
  const clusters = pairs.map((p) => clusterOf.get(p.a.id) ?? p.a.id);
  const metrics: [string, (q: QueryReport) => number][] = [
    [`hit@${a.k}`, (q) => (q.recallAtK > 0 ? 1 : 0)],
    ["mrr", (q) => q.mrr],
    [`ndcg@${a.k}`, (q) => q.ndcg],
  ];
  const stats = metrics.map(([, pick]) =>
    pairedClusterStatistics(
      pairs.map((p) => pick(p.a)),
      pairs.map((p) => pick(p.b)),
      clusters,
    ),
  );
  const holm = holmAdjusted(stats.map((s) => s.p_value));
  return {
    aggregate_only: false,
    paired: pairs.length,
    metrics: Object.fromEntries(
      metrics.map(([name], i) => [
        name,
        { ...stats[i]!, p_holm: holm[i]! },
      ]),
    ),
  };
}

function latencyRatio(b: number, a: number): number | null {
  return a > 0 ? Math.round((b / a) * 1000) / 1000 : null;
}

/** Why the requested split/prereg/record combination cannot run, or null. */
export function abRunRefusal(opts: {
  ab: boolean;
  split: EvalSplit;
  preregPath?: string;
  record?: boolean;
}): string | null {
  if (opts.record && !opts.ab) return "memrain eval: --record needs an A/B run (--config-b)";
  if (opts.split !== "sealed") return null;
  if (!opts.ab) return "memrain eval: the sealed split runs only as an A/B (--config-b)";
  if (!opts.preregPath) return "memrain eval: the sealed split needs --prereg PATH";
  // Recording is what makes the once-only rule enforceable.
  if (!opts.record) return "memrain eval: a sealed run is always recorded; pass --record";
  return null;
}

export async function runEval(opts: EvalOptions = {}): Promise<void> {
  const split = opts.split ?? "all";
  const refusal = abRunRefusal({
    ab: opts.configB !== undefined,
    split,
    ...(opts.preregPath !== undefined ? { preregPath: opts.preregPath } : {}),
    ...(opts.record !== undefined ? { record: opts.record } : {}),
  });
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }
  const allQrels = loadQrels(opts.qrelsPath ?? defaultQrelsPath());
  const qrels = filterSplit(allQrels, split);
  const k = opts.k ?? 5;
  const minRecall = opts.minRecall ?? 0.6;
  const cfgA: EvalKnobConfig = { name: "Config A", ...(opts.config ?? {}) };
  const preregSha256 =
    opts.preregPath !== undefined ? sha256Hex(readFileSync(opts.preregPath)) : undefined;

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
      if (split === "sealed" && (await sealedRunRecorded(storage.engine(), preregSha256!))) {
        console.error(
          `memrain eval: the sealed split was already scored under this prereg ` +
            `(sha256 ${preregSha256}); write a new pre-registration for another run.`,
        );
        process.exitCode = 1;
        return;
      }
      const cfgB: EvalKnobConfig = { name: "Config B", ...opts.configB };
      const { a, b } = await evalAB(storage, qrels, cfgA, cfgB, {
        k,
        split,
        ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
      });
      const delta = {
        meanRecall: b.meanRecall - a.meanRecall,
        meanReciprocalRank: b.meanReciprocalRank - a.meanReciprocalRank,
        hitRate: b.hitRate - a.hitRate,
      };
      const paired = pairedComparison(a, b, qrels);
      const latency = {
        a: a.latency,
        b: b.latency,
        ratio_p50: latencyRatio(b.latency.p50Ms, a.latency.p50Ms),
        ratio_p95: latencyRatio(b.latency.p95Ms, a.latency.p95Ms),
      };
      const errors = { a: a.errors.length, b: b.errors.length };
      const expectedTop1 = {
        count: b.expectedTop1.count,
        a_misses: a.expectedTop1.misses,
        b_misses: b.expectedTop1.misses,
      };
      const receipt = {
        split,
        qrels_sha256: a.qrels_sha256,
        ids_sha256: idsSha256(qrels),
        ...(split === "sealed" ? { sealed_ids_sha256: idsSha256(qrels) } : {}),
        ...(preregSha256 ? { prereg_sha256: preregSha256 } : {}),
        run_config_hash_a: a.run_config_hash,
        run_config_hash_b: b.run_config_hash,
      };
      let snapshotId: number | undefined;
      if (opts.record) {
        const recorded = await recordAbSnapshot(storage.engine(), {
          ranAt: new Date().toISOString(),
          totalQueries: qrels.queries.length,
          scored: b.scoredQueries,
          meanRR: b.meanReciprocalRank,
          hitRate: b.hitRate,
          detail: {
            ...receipt,
            k,
            config_a: cfgA,
            config_b: cfgB,
            paired,
            delta,
            latency,
            errors,
            expected_top1: expectedTop1,
          },
          ...(split === "sealed" ? { oncePerPrereg: preregSha256! } : {}),
        });
        if (!recorded) {
          console.error("memrain eval: a sealed run under this prereg was recorded meanwhile");
          process.exitCode = 1;
          return;
        }
        snapshotId = recorded.id;
      }
      const ok = errors.a === 0 && errors.b === 0;
      console.log(
        JSON.stringify(
          {
            ok,
            mode: "ab",
            k,
            receipt,
            ...(snapshotId !== undefined ? { snapshot_id: snapshotId } : {}),
            paired,
            latency,
            errors,
            expected_top1: expectedTop1,
            a,
            b,
            delta,
            glossary: METRIC_GLOSSARY,
          },
          null,
          2,
        ),
      );
      if (!ok) process.exitCode = 1;
      return;
    }

    const report = await evalRun(storage, qrels, cfgA, {
      k,
      split,
      ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
    });
    const ok = report.meanRecall >= minRecall;
    console.log(JSON.stringify({ ...report, ok, glossary: METRIC_GLOSSARY }, null, 2));
    if (!ok) process.exitCode = 1;
  });
}
