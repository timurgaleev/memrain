/**
 * `memrain bench scale` — latency and connection numbers at brain sizes the
 * live brain has not reached yet.
 *
 * Scenarios (one report):
 *   s1        one brain at `chunks` chunks: keyword and hybrid p95 against the
 *             Q51 targets, at `concurrency` parallel queries.
 *   s4Cold    the same brain after a Postgres restart: the first queries
 *             against the same queries once warm (the prewarm question, Q19).
 *   s2Direct  `tenants` brains of chunks/tenants each, one engine per brain
 *             with a tenant container's pool, all querying at once: any
 *             connection error fails it.
 *   s2Pooler  s2 again with every query going through `poolerUrl`. Skipped,
 *             with the reason in the report, when no pooler was given.
 *
 * PROTOCOL. A fixed query mix (`scale-corpus.ts`), `warmup` queries discarded,
 * then `runs` runs of `queries` queries per mode. p95 is nearest-rank over all
 * measured samples; each run's own p95 and the spread between runs are kept so
 * a noisy laptop shows up as noise. `protocol.compliant` says whether the run
 * met the agreed floor: ≥200 queries, ≥3 runs, ≥50 warmup, on a container
 * with known CPU/RAM limits and max_connections=200.
 *
 * WHERE IT WRITES: only databases it created and marked (`scale-target.ts`).
 * They are dropped before the report returns, and on failure.
 *
 * ZERO SPEND. The query vector comes from the `embedQuery` seam, every paid
 * ranking stage is off per call, and the paid env knobs are cleared for the
 * run. The report carries the proof: rows in every bench database's spend
 * ledger (0), and seam calls equal to hybrid queries — a hybrid query that
 * embedded any other way would break the equality.
 *
 * The report never carries a URL's credentials: servers appear as host:port.
 */
import { cpus, totalmem, platform, arch } from "node:os";
import { PostgresEngine } from "../engine/postgres.ts";
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { BENCH_EMBED_MODEL, CHUNKS_PER_DOC, QUERY_MIX, queryList } from "./scale-corpus.ts";
import {
  APP_NAME,
  ScaleBenchRefusal,
  assertBenchContainer,
  assertBenchTarget,
  assertNotProductionServer,
  assertPoolerBesideAdmin,
  createScratchDatabase,
  displayServer,
  dropScratchDatabase,
  loadScaleCorpus,
  openBenchBrain,
  withDatabase,
  type BenchBrain,
  type Env,
  type LoadStats,
  type ScratchTarget,
} from "./scale-target.ts";
import {
  ConnectionSampler,
  armFailureCount,
  connectionErrorCount,
  judge,
  measure,
  mergeErrors,
  round,
  runQueries,
  searchOptions,
  summarizeRuns,
  type Counters,
  type ErrorCounts,
  type LatencySummary,
  type ProtocolParams,
  type Verdict,
} from "./scale-measure.ts";

export * from "./scale-target.ts";
export {
  armFailures,
  judge,
  percentileNearestRank,
  summarizeRuns,
  type LatencySummary,
  type Verdict,
} from "./scale-measure.ts";

/** Q51: the targets one brain at 100k chunks is measured against. */
export const Q51_TARGETS = { hybridP95Ms: 800, keywordP95Ms: 300 } as const;

/** The agreed measurement floor (plan amendment S-R1). */
export const PROTOCOL_FLOOR = { queries: 200, runs: 3, warmup: 50 } as const;

/** Q19: a cold p95 above this multiple of the warm one makes the case for prewarm. */
export const COLD_PREWARM_RATIO = 2;

/** A tenant container's pool (deploy/tenant/tenant.yml.tmpl). */
const TENANT_POOL_MAX = 4;
const COLD_SAMPLE = 20;

/** Knobs that would turn a search into a paid call, or keyword-only; cleared for the run. */
const PAID_SEARCH_ENV = [
  "MEMRAIN_INTENT_LLM",
  "MEMRAIN_RERANK",
  "MEMRAIN_GRAPH_RERANK",
  "MEMRAIN_QUERY_EXPANSION",
  "MEMRAIN_SEARCH_MODE",
  "MEMRAIN_KEYWORD_ONLY",
] as const;

export interface ScaleBenchOptions {
  /** A URL on a throwaway server that may CREATE DATABASE: the bench makes its databases there. */
  adminUrl: string;
  /** The caller's statement that the server is throwaway. Required; never overrides the production refusal. */
  scratch: boolean;
  /** The environment the production refusal reads. Defaults to process.env. */
  env?: Env;
  seed?: string;
  chunks?: number;
  tenants?: number;
  concurrency?: number;
  queries?: number;
  runs?: number;
  warmup?: number;
  /** PgBouncer in front of the same server; s2 is repeated through it. */
  poolerUrl?: string;
  /** The bench script's container: read for CPU/RAM limits, restarted for the cold scenario. */
  container?: string;
  cold?: boolean;
  /** Progress lines; stderr from the CLI. */
  log?: (line: string) => void;
}

export interface S1Report {
  chunks: number;
  documents: number;
  corpusSha256: string;
  loadMs: number;
  hnswBuildMs: number;
  concurrency: number;
  keyword: LatencySummary;
  hybrid: LatencySummary;
  targets: typeof Q51_TARGETS;
  verdict: { keyword: Verdict; hybrid: Verdict };
  errors: ErrorCounts;
  peakConnections: number;
}

export interface S2Report {
  skipped?: false;
  via: "direct" | "pooler";
  chunksPerTenant: number;
  concurrencyPerTenant: number;
  poolMaxPerTenant: number;
  tenants: { corpusSha256: string; hybrid: LatencySummary; errors: ErrorCounts }[];
  /** All tenants pooled; run r of every tenant ran at the same time. */
  hybrid: LatencySummary;
  errors: ErrorCounts;
  connectionErrors: number;
  /** Searches that came back with an arm missing (an error the search swallowed). */
  armFailures: number;
  verdict: "pass" | "fail";
  peakConnections: number;
}

export interface Skipped {
  skipped: true;
  reason: string;
}

export interface S4Report {
  skipped?: false;
  restartMs: number;
  coldSample: number;
  firstQueryMs: number;
  cold: LatencySummary;
  warm: LatencySummary;
  ratioP95: number | null;
  prewarmWarranted: boolean;
  errors: ErrorCounts;
  note: string;
}

export interface ScaleReport {
  schema: "memrain.bench.scale/1";
  startedAt: string;
  finishedAt: string;
  seed: string;
  params: {
    chunks: number;
    tenants: number;
    concurrency: number;
    queries: number;
    runs: number;
    warmup: number;
    server: string;
    pooler: string | null;
    queryMix: { kind: string; share: number; note: string }[];
    chunksPerDoc: number;
    embedModel: string;
    searchOptions: string;
  };
  protocol: { floor: typeof PROTOCOL_FLOOR; compliant: boolean; percentile: "nearest-rank" };
  hardware: Record<string, unknown>;
  scenarios: {
    s1: S1Report;
    s4Cold: S4Report | Skipped;
    s2Direct: S2Report;
    s2Pooler: S2Report | Skipped;
  };
  peakConnections: { total: number; perDb: Record<string, number> };
  spend: { ledgerCalls: number; ledgerUsd: number; embedSeamCalls: number; hybridQueries: number };
  /** Every database the run created (all dropped before the report returns). */
  databases: string[];
}

// ---------------------------------------------------------------- docker + server facts

async function docker(args: string[]): Promise<string> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]} exited ${code}`);
  return text;
}

async function containerLimits(name: string): Promise<Record<string, unknown>> {
  assertBenchContainer(name);
  const raw = JSON.parse(await docker(["inspect", "--format", "{{json .HostConfig}}", name])) as {
    NanoCpus?: number;
    Memory?: number;
  };
  return { cpus: raw.NanoCpus ? raw.NanoCpus / 1e9 : null, memoryBytes: raw.Memory || null };
}

async function serverFacts(engine: Engine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const settings = [
    "server_version", "max_connections", "shared_buffers", "work_mem",
    "maintenance_work_mem", "max_parallel_maintenance_workers", "effective_cache_size",
  ];
  for (const name of settings) {
    const r = await engine.query<Record<string, string>>(`SHOW ${name}`);
    out[name] = String(Object.values(r.rows[0] ?? {})[0] ?? "");
  }
  // The admin database has no extension installed; the available version is
  // what every bench database's `CREATE EXTENSION vector` gets.
  const v = await engine.query<{ v: string }>(
    `SELECT default_version AS v FROM pg_available_extensions WHERE name = 'vector'`,
  );
  out.pgvector = v.rows[0]?.v ?? "";
  return out;
}

async function waitForServer(adminUrl: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const e = new PostgresEngine({ url: adminUrl, max: 1, applicationName: APP_NAME });
    try {
      await e.query("SELECT 1");
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await Bun.sleep(250);
    } finally {
      await e.close().catch(() => undefined);
    }
  }
}

async function ledger(engine: Engine): Promise<{ calls: number; usd: number }> {
  const r = await engine.query<{ calls: number; cents: number }>(
    `SELECT count(*)::int AS calls, COALESCE(SUM(spend_cents), 0)::float8 AS cents FROM mcp_spend_log`,
  );
  return { calls: Number(r.rows[0]?.calls ?? 0), usd: Number(r.rows[0]?.cents ?? 0) / 100 };
}

/** The server ran with the agreed fixed shape: container limits known, max_connections=200. */
function fixedServer(hardware: Record<string, unknown>): boolean {
  const container = hardware.container as { cpus?: number | null; memoryBytes?: number | null } | null;
  const pg = hardware.postgres as Record<string, string>;
  return !!container?.cpus && !!container.memoryBytes && pg.max_connections === "200";
}

// ---------------------------------------------------------------- run context

interface Loaded {
  target: ScratchTarget;
  brain: BenchBrain;
  stats: LoadStats;
}

/** What every scenario shares: the server, the protocol, the counters, and the cleanup lists. */
class Run {
  readonly created: ScratchTarget[] = [];
  readonly engines: PostgresEngine[] = [];
  readonly counters: Counters = { embedSeamCalls: 0, hybridQueries: 0 };
  readonly spend = { calls: 0, usd: 0 };
  readonly sampler: ConnectionSampler;

  constructor(
    readonly adminUrl: string,
    readonly env: Env,
    readonly p: ProtocolParams,
    readonly log: (line: string) => void,
  ) {
    this.sampler = new ConnectionSampler(adminUrl);
  }

  track(e: PostgresEngine): PostgresEngine {
    this.engines.push(e);
    return e;
  }

  queryEngine(url: string, max: number): PostgresEngine {
    return this.track(new PostgresEngine({ url, max, applicationName: APP_NAME }));
  }

  async newBrain(corpusSeed: string, chunks: number): Promise<Loaded> {
    const target = await createScratchDatabase(this.adminUrl, { env: this.env });
    this.created.push(target);
    const brain = await openBenchBrain(target);
    this.track(brain.engine);
    const stats = await loadScaleCorpus(brain.engine, target, { seed: corpusSeed, chunks });
    return { target, brain, stats };
  }

  /**
   * Read a brain's spend ledger into the total, then close and drop it. The
   * ledger is read on a fresh connection: the load engine's may have died in
   * the s4 restart.
   */
  async retire(b: Loaded): Promise<void> {
    await b.brain.engine.close();
    const e = new PostgresEngine({ url: b.target.url, max: 1, applicationName: APP_NAME });
    try {
      await assertBenchTarget(e, b.target);
      const l = await ledger(e);
      this.spend.calls += l.calls;
      this.spend.usd += l.usd;
    } finally {
      await e.close();
    }
    await dropScratchDatabase(this.adminUrl, b.target);
  }
}

// ---------------------------------------------------------------- scenarios

async function scenarioS1(run: Run, s1: Loaded): Promise<{ report: S1Report; engine: PostgresEngine }> {
  run.sampler.takeScenarioPeak();
  const engine = run.queryEngine(s1.target.url, run.p.concurrency);
  await assertBenchTarget(engine, s1.target);
  const storage = new Storage(engine);
  const kw = await measure(storage, "s1", "keyword", run.p, run.counters);
  run.log(`s1: keyword p95 ${kw.summary.p95}ms`);
  const hy = await measure(storage, "s1", "hybrid", run.p, run.counters);
  run.log(`s1: hybrid p95 ${hy.summary.p95}ms`);
  await run.sampler.sample();
  const errors: ErrorCounts = {};
  mergeErrors(errors, kw.errors);
  mergeErrors(errors, hy.errors);
  return {
    engine,
    report: {
      chunks: s1.stats.chunks,
      documents: s1.stats.documents,
      corpusSha256: s1.stats.corpusSha256,
      loadMs: Math.round(s1.stats.loadMs),
      hnswBuildMs: Math.round(s1.stats.hnswBuildMs),
      concurrency: run.p.concurrency,
      keyword: kw.summary,
      hybrid: hy.summary,
      targets: Q51_TARGETS,
      verdict: {
        keyword: judge(kw.summary.p95, Q51_TARGETS.keywordP95Ms),
        hybrid: judge(hy.summary.p95, Q51_TARGETS.hybridP95Ms),
      },
      errors,
      peakConnections: run.sampler.takeScenarioPeak(),
    },
  };
}

/**
 * Restart Postgres under the s1 brain, then: the first COLD_SAMPLE hybrid
 * queries, a warmup, and the same sample again `runs` times. One query at a
 * time throughout, so cold and warm differ only in what the server has cached.
 */
async function scenarioS4(run: Run, s1: Loaded, container: string, open: PostgresEngine[]): Promise<S4Report> {
  for (const e of open) await e.close();
  const t0 = performance.now();
  assertBenchContainer(container);
  await docker(["restart", container]);
  await waitForServer(run.adminUrl);
  const restartMs = performance.now() - t0;
  const engine = run.queryEngine(s1.target.url, 1);
  await assertBenchTarget(engine, s1.target);
  const storage = new Storage(engine);
  const opts = searchOptions(run.p.seed, run.counters);
  const sample = queryList(run.p.seed, "s4:cold", COLD_SAMPLE);
  const cold = await runQueries(storage, sample, "hybrid", 1, opts, run.counters);
  const errors: ErrorCounts = { ...cold.errors };
  const warmup = await runQueries(storage, queryList(run.p.seed, "s4:warmup", run.p.warmup), "hybrid", 1, opts, run.counters);
  mergeErrors(errors, warmup.errors);
  const warmRuns: number[][] = [];
  for (let r = 0; r < run.p.runs; r++) {
    const w = await runQueries(storage, sample, "hybrid", 1, opts, run.counters);
    warmRuns.push(w.latencies);
    mergeErrors(errors, w.errors);
  }
  await engine.close();
  const coldSummary = summarizeRuns([cold.latencies]);
  const warmSummary = summarizeRuns(warmRuns);
  const ratio = coldSummary.p95 !== null && warmSummary.p95 ? coldSummary.p95 / warmSummary.p95 : null;
  run.log(`s4: cold p95 ${coldSummary.p95}ms vs warm ${warmSummary.p95}ms`);
  return {
    restartMs: Math.round(restartMs),
    coldSample: COLD_SAMPLE,
    firstQueryMs: round(cold.latencies[0] ?? 0),
    cold: coldSummary,
    warm: warmSummary,
    ratioP95: ratio === null ? null : round(ratio),
    prewarmWarranted: ratio !== null && ratio > COLD_PREWARM_RATIO,
    errors,
    note:
      "cold = the first hybrid queries after a Postgres restart (shared buffers empty); the Docker VM's " +
      "OS page cache is not dropped, so this is a lower bound on a cold host",
  };
}

/** Every tenant brain querying at once, each through its own tenant-sized pool. */
async function scenarioS2(run: Run, brains: Loaded[], via: "direct" | "pooler", poolerUrl?: string): Promise<S2Report> {
  run.sampler.takeScenarioPeak();
  const results = await Promise.all(
    brains.map(async (b) => {
      const url = via === "direct" ? b.target.url : withDatabase(poolerUrl!, b.target.dbName);
      const e = run.queryEngine(url, TENANT_POOL_MAX);
      await assertBenchTarget(e, b.target);
      const m = await measure(new Storage(e), `s2:${via}`, "hybrid", run.p, run.counters);
      await e.close();
      return { corpusSha256: b.stats.corpusSha256, hybrid: m.summary, errors: m.errors, runs: m.runs };
    }),
  );
  await run.sampler.sample();
  const errors: ErrorCounts = {};
  for (const r of results) mergeErrors(errors, r.errors);
  const conn = connectionErrorCount(errors);
  const arms = armFailureCount(errors);
  run.log(`s2 ${via}: ${conn} connection errors, ${arms} searches missing an arm`);
  return {
    via,
    chunksPerTenant: brains[0]?.stats.chunks ?? 0,
    concurrencyPerTenant: run.p.concurrency,
    poolMaxPerTenant: TENANT_POOL_MAX,
    tenants: results.map(({ corpusSha256, hybrid, errors: e }) => ({ corpusSha256, hybrid, errors: e })),
    hybrid: summarizeRuns(Array.from({ length: run.p.runs }, (_, r) => results.flatMap((x) => x.runs[r] ?? []))),
    errors,
    connectionErrors: conn,
    armFailures: arms,
    verdict: conn === 0 && arms === 0 ? "pass" : "fail",
    peakConnections: run.sampler.takeScenarioPeak(),
  };
}

// ---------------------------------------------------------------- entry

function intOpt(name: string, v: number | undefined, dflt: number, min: number): number {
  const n = v ?? dflt;
  if (!Number.isInteger(n) || n < min) throw new Error(`memrain bench scale: --${name} must be an integer >= ${min}`);
  return n;
}

/** Refusals first: none of them opens a connection. */
function preflight(opts: ScaleBenchOptions, env: Env): void {
  // The production refusal outranks --scratch: it is checked whatever the flag says.
  assertNotProductionServer(opts.adminUrl, env);
  if (opts.poolerUrl) {
    assertNotProductionServer(opts.poolerUrl, env);
    assertPoolerBesideAdmin(opts.poolerUrl, opts.adminUrl);
  }
  if (!opts.scratch) {
    throw new ScaleBenchRefusal(
      "bench_needs_scratch",
      "pass --scratch to confirm the admin URL is a throwaway server; the bench creates and drops databases there",
    );
  }
  if (opts.container) assertBenchContainer(opts.container);
}

/** The whole bench. Every database created is dropped, on success and on failure. */
export async function runScaleBench(opts: ScaleBenchOptions): Promise<ScaleReport> {
  const env = opts.env ?? process.env;
  preflight(opts, env);
  const seed = opts.seed ?? "1";
  const chunks = intOpt("chunks", opts.chunks, 100_000, 1);
  const tenants = intOpt("tenants", opts.tenants, 8, 1);
  const p: ProtocolParams = {
    seed,
    concurrency: intOpt("concurrency", opts.concurrency, 4, 1),
    queries: intOpt("queries", opts.queries, PROTOCOL_FLOOR.queries, 1),
    runs: intOpt("runs", opts.runs, PROTOCOL_FLOOR.runs, 1),
    warmup: intOpt("warmup", opts.warmup, PROTOCOL_FLOOR.warmup, 0),
  };
  const run = new Run(opts.adminUrl, env, p, opts.log ?? (() => {}));

  const savedEnv: Env = {};
  for (const k of PAID_SEARCH_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const startedAt = new Date().toISOString();
  try {
    const admin = run.track(new PostgresEngine({ url: opts.adminUrl, max: 1, applicationName: APP_NAME }));
    const hardware: Record<string, unknown> = {
      host: { platform: platform(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? "", memoryBytes: totalmem() },
      postgres: await serverFacts(admin),
      container: opts.container ? await containerLimits(opts.container) : null,
      bun: Bun.version,
    };
    run.sampler.start();

    run.log(`s1: loading ${chunks} chunks`);
    const s1Brain = await run.newBrain(seed, chunks);
    run.log(`s1: loaded in ${Math.round(s1Brain.stats.loadMs)}ms, hnsw ${Math.round(s1Brain.stats.hnswBuildMs)}ms`);
    const s1 = await scenarioS1(run, s1Brain);
    const s4Cold: S4Report | Skipped =
      opts.cold && opts.container
        ? await scenarioS4(run, s1Brain, opts.container, [s1.engine, s1Brain.brain.engine, admin])
        : { skipped: true, reason: "needs --cold and --container (scripts/scale-bench.sh passes both)" };
    await s1.engine.close();
    await run.retire(s1Brain);

    const perTenant = Math.max(1, Math.floor(chunks / tenants));
    run.log(`s2: loading ${tenants} brains of ${perTenant} chunks`);
    const brains: Loaded[] = [];
    for (let t = 0; t < tenants; t++) brains.push(await run.newBrain(`${seed}:t${t}`, perTenant));
    const s2Direct = await scenarioS2(run, brains, "direct");
    const s2Pooler: S2Report | Skipped = opts.poolerUrl
      ? await scenarioS2(run, brains, "pooler", opts.poolerUrl)
      : {
          skipped: true,
          reason:
            "no --pooler-url: scripts/scale-bench.sh supplies one once the PgBouncer image (deploy/pgbouncer) is in the tree",
        };
    for (const b of brains) await run.retire(b);

    return {
      schema: "memrain.bench.scale/1",
      startedAt,
      finishedAt: new Date().toISOString(),
      seed,
      params: {
        chunks,
        tenants,
        concurrency: p.concurrency,
        queries: p.queries,
        runs: p.runs,
        warmup: p.warmup,
        server: displayServer(opts.adminUrl),
        pooler: opts.poolerUrl ? displayServer(opts.poolerUrl) : null,
        queryMix: QUERY_MIX.map((m) => ({ ...m })),
        chunksPerDoc: CHUNKS_PER_DOC,
        embedModel: BENCH_EMBED_MODEL,
        searchOptions: "k=20 rerank=off graphRerank=off expansion=off cache=off telemetry=off intent=zero-llm",
      },
      protocol: {
        floor: PROTOCOL_FLOOR,
        compliant:
          p.queries >= PROTOCOL_FLOOR.queries &&
          p.runs >= PROTOCOL_FLOOR.runs &&
          p.warmup >= PROTOCOL_FLOOR.warmup &&
          fixedServer(hardware),
        percentile: "nearest-rank",
      },
      hardware,
      scenarios: { s1: s1.report, s4Cold, s2Direct, s2Pooler },
      peakConnections: { total: run.sampler.peakTotal, perDb: run.sampler.peakPerDb },
      spend: {
        ledgerCalls: run.spend.calls,
        ledgerUsd: run.spend.usd,
        embedSeamCalls: run.counters.embedSeamCalls,
        hybridQueries: run.counters.hybridQueries,
      },
      databases: run.created.map((t) => t.dbName),
    };
  } finally {
    await run.sampler.stop();
    for (const e of run.engines) await e.close().catch(() => undefined);
    for (const t of run.created) await dropScratchDatabase(opts.adminUrl, t).catch(() => undefined);
    for (const k of PAID_SEARCH_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}
