/**
 * The search bench: a synthetic corpus that ships next to this file, scored
 * through the real hybrid search on a throwaway PGLite brain.
 *
 * The corpus is fictional (people, projects, meetings, code notes, decisions,
 * transcripts, a few German pages) plus mail noise — newsletters, automatic
 * replies, receipts and invitations that repeat the same names and terms —
 * indexed under a `mailbox` source, so the bench also shows what a mailbox
 * does to the ranking of the pages people wrote. Every query carries tags
 * (`kind:*`, `intent:*`, `noise:mail`) and a language, and the report breaks
 * every metric down by them. Decoy entries carry a plausible wrong answer
 * (`decoy_output`) the scorer must reject; a scorer that passes any of them
 * would pass the same mistake from the search, so no other number counts.
 *
 * Zero model spend, measured. Chunks and queries are embedded with the
 * deterministic bag-of-words embedder, the intent comes from the zero-LLM
 * classifier, and every paid stage (rerank, graph rerank, expansion) is off.
 * The run reads its own database's spend ledger before and after, and a
 * nonzero delta fails it. A setting that would make the indexer call a model
 * (contextual retrieval) refuses the run before anything is indexed.
 *
 * The brain lives in a mkdtemp directory and is removed afterwards; the
 * operator's brain is never opened.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../../core/storage.ts";
import { indexDocument } from "../../core/indexer.ts";
import { registerSource } from "../../core/sources.ts";
import { hybridSearch } from "../../core/search/hybrid.ts";
import { classifyIntentZeroLlm } from "../../core/search/intent.ts";
import { contextualLlmEnabled } from "../../core/search/contextual-llm.ts";
import {
  binaryGrades,
  distinctInOrder,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
} from "../../core/search/metrics.ts";
import { loadQrels, type EvalOptions, type Qrel, type Qrels } from "../../commands/eval.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./deterministic-embed.ts";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const BENCH_EMBED_MODEL = "deterministic-bench";
export const BENCH_VAULT_SOURCE = "bench-vault";
export const BENCH_MAIL_SOURCE = "bench-mail";
/** Ranked pages kept per query for the snapshot and the @10 metrics. */
export const BENCH_DEPTH = 10;
/** Chunks fetched per page wanted, so ten distinct pages usually remain. */
const PAGE_OVERFETCH = 3;

export interface BenchQrel extends Qrel {
  tags: string[];
  lang: string;
  /** A wrong answer the scorer must reject. Decoys are never searched. */
  decoy_output?: string[];
}
export interface BenchQrels extends Qrels {
  queries: BenchQrel[];
}

export class BenchUnsafeConfig extends Error {
  override name = "BenchUnsafeConfig";
}

export function benchQrelsPath(): string {
  return join(BENCH_DIR, "qrels.json");
}

export function benchSnapshotPath(): string {
  return join(BENCH_DIR, "snapshot.json");
}

const TAG = /^[a-z0-9]+(?::[a-z0-9-]+)?$/;

export function loadBenchQrels(path = benchQrelsPath()): BenchQrels {
  const qrels = loadQrels(path) as BenchQrels;
  for (const q of qrels.queries) {
    if (!Array.isArray(q.tags) || q.tags.length === 0 || !q.tags.every((t) => typeof t === "string" && TAG.test(t))) {
      throw new Error(`bench qrels: query ${q.id} needs tags like "kind:alias"`);
    }
    if (typeof q.lang !== "string" || !/^[a-z]{2}$/.test(q.lang)) {
      throw new Error(`bench qrels: query ${q.id} needs a two-letter lang`);
    }
    if (q.decoy_output !== undefined && (!Array.isArray(q.decoy_output) || q.expected_paths.length === 0)) {
      throw new Error(`bench qrels: decoy ${q.id} needs expected_paths and a decoy_output list`);
    }
  }
  return qrels;
}

/** The queries the search runs: every entry but the decoys. */
export function scoredQrels(qrels: BenchQrels): BenchQrels {
  return { ...qrels, queries: qrels.queries.filter((q) => q.decoy_output === undefined) };
}

export interface CorpusFile {
  sourcePath: string;
  sourceId: string;
  text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : name.endsWith(".md") ? [full] : [];
    });
}

/** Every corpus page, in a stable order, with the path and source it is indexed under. */
export function benchCorpusFiles(opts: { includeMail?: boolean } = {}): CorpusFile[] {
  const sets: [string, string][] = [["vault", BENCH_VAULT_SOURCE]];
  if (opts.includeMail !== false) sets.push(["mail", BENCH_MAIL_SOURCE]);
  return sets.flatMap(([kind, sourceId]) => {
    const root = join(BENCH_DIR, "corpus", kind);
    return walk(root).map((file) => ({
      sourcePath: `/bench/${kind}/${relative(root, file)}`,
      sourceId,
      text: readFileSync(file, "utf8"),
    }));
  });
}

export interface BenchBrain {
  storage: Storage;
  close: () => Promise<void>;
}

/** A fresh brain holding the bench corpus. The caller closes it. */
export async function openBenchBrain(opts: { includeMail?: boolean } = {}): Promise<BenchBrain> {
  if (contextualLlmEnabled()) {
    throw new BenchUnsafeConfig("MEMRAIN_CONTEXTUAL_LLM is on: indexing the bench would call a model; unset it for the run");
  }
  const dir = mkdtempSync(join(tmpdir(), "memrain-search-bench-"));
  const storage = new Storage({ dbPath: join(dir, "brain") });
  let opened = false;
  const close = async () => {
    if (opened) await storage.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await storage.init();
    opened = true;
    const engine = storage.engine();
    await registerSource(engine, { id: BENCH_VAULT_SOURCE, kind: "vault", pathPrefix: "/bench/vault/" });
    await registerSource(engine, { id: BENCH_MAIL_SOURCE, kind: "mailbox", pathPrefix: "/bench/mail/" });
    for (const f of benchCorpusFiles(opts)) {
      await indexDocument(storage, { sourcePath: f.sourcePath, text: f.text, sourceId: f.sourceId }, {
        embeddingModel: BENCH_EMBED_MODEL,
        embedFn: async (text) => deterministicEmbed(text),
        inferFrontmatter: false,
        requireCompleteEmbeddings: true,
      });
    }
    return { storage, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * Distinct pages, best first, for one query: production ranking minus every
 * paid stage. The bench embeds the query deterministically; a live brain
 * passes `live` to embed it with the brain's own model.
 */
export async function benchRankedPaths(storage: Storage, query: string, depth = BENCH_DEPTH, live = false): Promise<string[]> {
  const hits = await hybridSearch(storage, query, {
    k: depth * PAGE_OVERFETCH,
    intent: classifyIntentZeroLlm(query),
    ...(live ? {} : { embedQuery: deterministicEmbedQuery }),
    noCache: true,
    noTelemetry: true,
    rerank: false,
    graphRerank: false,
    expansion: false,
    noExpansion: true,
  });
  return distinctInOrder(hits.map((h) => h.sourcePath)).slice(0, depth);
}

/** The eval harness's search seam, answered from the bench brain. */
export const benchSearchFn: NonNullable<EvalOptions["searchFn"]> = async (storage, query, _cfg, k) =>
  (await benchRankedPaths(storage, query, Math.max(k, BENCH_DEPTH))).slice(0, k);

export interface DecoyReport {
  total: number;
  /** Decoy ids whose wrong answer the scorer accepted. Must stay empty. */
  passed: string[];
}

/** Score each decoy's planted answer exactly as a search result is scored (hit@k). */
export function decoyReport(qrels: BenchQrels, k: number): DecoyReport {
  const decoys = qrels.queries.filter((q) => q.decoy_output !== undefined);
  const passed = decoys
    .filter((q) => recallAtK(distinctInOrder(q.decoy_output!), new Set(q.expected_paths), k) > 0)
    .map((q) => q.id);
  return { total: decoys.length, passed };
}

export interface BenchMetrics {
  n: number;
  hit_at_5: number;
  mrr: number;
  ndcg_at_10: number;
  recall_at_10: number;
}

export interface QueryScore {
  hit5: number;
  rr: number;
  ndcg10: number;
  recall10: number;
}

export function scoreRanked(paths: string[], q: Qrel): QueryScore {
  const expected = new Set(q.expected_paths);
  return {
    hit5: recallAtK(paths, expected, 5) > 0 ? 1 : 0,
    rr: reciprocalRank(paths, expected),
    ndcg10: ndcgAtK(paths, binaryGrades(q.expected_paths), BENCH_DEPTH),
    recall10: recallAtK(paths, expected, BENCH_DEPTH),
  };
}

export function meanScores(scores: QueryScore[]): BenchMetrics {
  const n = scores.length;
  const avg = (pick: (s: QueryScore) => number) => (n === 0 ? 0 : scores.reduce((a, s) => a + pick(s), 0) / n);
  return { n, hit_at_5: avg((s) => s.hit5), mrr: avg((s) => s.rr), ndcg_at_10: avg((s) => s.ndcg10), recall_at_10: avg((s) => s.recall10) };
}

export interface BenchReport {
  ok: boolean;
  qrels_sha256: string;
  embed_model: string;
  mail_noise: boolean;
  /** Non-decoy queries run. */
  queries: number;
  overall: BenchMetrics;
  by_tag: Record<string, BenchMetrics>;
  abstention: { n: number; returned_any: number };
  decoys: DecoyReport;
  errors: { id: string; error: string }[];
  /** Model calls the run booked on its own ledger. Anything but zero fails it. */
  spend: { calls: number; usd: number };
  /** Top pages per query id: the snapshot a refactor must leave unchanged. */
  ranked: Record<string, string[]>;
  /** Per-query scores, for paired comparisons. */
  per_query: Record<string, QueryScore & { tags: string[] }>;
}

async function spendSnapshot(storage: Storage): Promise<{ calls: number; usd: number }> {
  const r = await storage.engine().query<{ calls: number; cents: number }>(
    `SELECT count(*)::int AS calls, COALESCE(SUM(spend_cents), 0)::float8 AS cents FROM mcp_spend_log`,
  );
  return { calls: Number(r.rows[0]?.calls ?? 0), usd: Number(r.rows[0]?.cents ?? 0) / 100 };
}

export interface RunBenchOptions {
  qrelsPath?: string;
  /** false indexes the vault pages only (the K12 comparison). */
  includeMail?: boolean;
  /** MEMRAIN_* variables set around every query, then restored. */
  env?: Record<string, string>;
}

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

/** Score the bench on an already open brain. */
export async function scoreBench(brain: BenchBrain, qrels: BenchQrels, opts: { env?: Record<string, string>; mailNoise?: boolean } = {}): Promise<BenchReport> {
  const before = await spendSnapshot(brain.storage);
  const ranked: Record<string, string[]> = {};
  const perQuery: BenchReport["per_query"] = {};
  const errors: BenchReport["errors"] = [];
  const scored: { q: BenchQrel; s: QueryScore }[] = [];
  let abstentions = 0;
  let returnedAny = 0;
  for (const q of scoredQrels(qrels).queries) {
    const restore = applyEnv(opts.env ?? {});
    let paths: string[];
    try {
      paths = await benchRankedPaths(brain.storage, q.query);
    } catch (e) {
      errors.push({ id: q.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    } finally {
      restore();
    }
    ranked[q.id] = paths;
    if (q.expected_paths.length === 0) {
      abstentions++;
      if (paths.length > 0) returnedAny++;
      continue;
    }
    const s = scoreRanked(paths, q);
    perQuery[q.id] = { ...s, tags: q.tags };
    scored.push({ q, s });
  }
  const spent = await spendSnapshot(brain.storage);
  const spend = { calls: spent.calls - before.calls, usd: Math.round((spent.usd - before.usd) * 1e6) / 1e6 };
  const byTag: Record<string, QueryScore[]> = {};
  for (const { q, s } of scored) {
    for (const tag of [...q.tags, `lang:${q.lang}`]) (byTag[tag] ??= []).push(s);
  }
  const decoys = decoyReport(qrels, 5);
  return {
    ok: decoys.passed.length === 0 && spend.calls === 0 && errors.length === 0,
    qrels_sha256: qrels.sha256 ?? "",
    embed_model: BENCH_EMBED_MODEL,
    mail_noise: opts.mailNoise ?? true,
    queries: Object.keys(ranked).length + errors.length,
    overall: meanScores(scored.map((x) => x.s)),
    by_tag: Object.fromEntries(Object.entries(byTag).sort(([a], [b]) => a.localeCompare(b)).map(([t, s]) => [t, meanScores(s)])),
    abstention: { n: abstentions, returned_any: returnedAny },
    decoys,
    errors,
    spend,
    ranked,
    per_query: perQuery,
  };
}

export interface BenchSnapshot {
  qrels_sha256: string;
  embed_model: string;
  depth: number;
  ranked: Record<string, string[]>;
}

export function benchSnapshot(report: BenchReport): BenchSnapshot {
  return { qrels_sha256: report.qrels_sha256, embed_model: report.embed_model, depth: BENCH_DEPTH, ranked: report.ranked };
}

export function readBenchSnapshot(path = benchSnapshotPath()): BenchSnapshot {
  return JSON.parse(readFileSync(path, "utf8")) as BenchSnapshot;
}

/** Query ids whose ranked pages differ from the snapshot, plus any the snapshot lacks or has extra. */
export function snapshotDiff(snapshot: BenchSnapshot, report: BenchReport): string[] {
  const ids = new Set([...Object.keys(snapshot.ranked), ...Object.keys(report.ranked)]);
  return [...ids].sort().filter((id) => JSON.stringify(snapshot.ranked[id] ?? null) !== JSON.stringify(report.ranked[id] ?? null));
}

/** How far the `noise:mail` queries may lose MRR to the mailbox before K12 fails. */
export const K12_MAX_MRR_DROP = 0.01;

export interface K12Result {
  pass: boolean;
  with_mail: BenchMetrics | null;
  without_mail: BenchMetrics | null;
  /** Query ids whose first page is a mail page. */
  mail_rank1: string[];
  reasons: string[];
}

/**
 * K12: the mailbox's lower source weight must keep mail noise from displacing
 * the pages people wrote. Compares the `noise:mail` queries with the mailbox
 * indexed and without it.
 */
export function k12Check(withMail: BenchReport, withoutMail: BenchReport): K12Result {
  const a = withMail.by_tag["noise:mail"] ?? null;
  const b = withoutMail.by_tag["noise:mail"] ?? null;
  const mailRank1 = Object.entries(withMail.ranked)
    .filter(([, paths]) => paths[0]?.startsWith("/bench/mail/"))
    .map(([id]) => id)
    .sort();
  const reasons: string[] = [];
  if (!a || !b) reasons.push("no query is tagged noise:mail");
  if (mailRank1.length > 0) reasons.push(`a mail page ranks first for ${mailRank1.join(", ")}`);
  if (a && b && a.hit_at_5 < b.hit_at_5) reasons.push(`hit@5 fell from ${b.hit_at_5.toFixed(3)} to ${a.hit_at_5.toFixed(3)}`);
  if (a && b && b.mrr - a.mrr > K12_MAX_MRR_DROP) reasons.push(`MRR fell from ${b.mrr.toFixed(3)} to ${a.mrr.toFixed(3)}`);
  return { pass: reasons.length === 0, with_mail: a, without_mail: b, mail_rank1: mailRank1, reasons };
}

/** Open a bench brain, score it, close it. */
export async function runBench(opts: RunBenchOptions = {}): Promise<BenchReport> {
  const qrels = loadBenchQrels(opts.qrelsPath);
  const brain = await openBenchBrain({ ...(opts.includeMail !== undefined ? { includeMail: opts.includeMail } : {}) });
  try {
    return await scoreBench(brain, qrels, { ...(opts.env ? { env: opts.env } : {}), mailNoise: opts.includeMail !== false });
  } finally {
    await brain.close();
  }
}
