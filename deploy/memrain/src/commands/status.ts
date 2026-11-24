/**
 * `memrain status` — one-shot operational snapshot of the brain.
 *
 * Bundles the three signals an operator usually wants at a glance into a single
 * JSON object: index counts (`stats`), data/ingest health (embed coverage,
 * staleness lag). Read-only — unlike `doctor` it makes no pass/fail judgement
 * and, without `--quiescent`, sets no exit code; it just reports the numbers.
 *
 * `stats.pages` (every pages row), `oauth_self_issued` and `oauth_clients_live`
 * are what a deploy checks before it opens ingress: an empty corpus, or the
 * OAuth provider off while live clients exist, after an upgrade means the
 * wrong data dir or a recreated config.
 *
 * `quiescence` reports the background-work switches as this process resolves
 * them (inside the serve container that is the server's own env) and what is
 * still running in the database. `--quiescent` turns it into a check: exit 3
 * unless nothing can write on its own, which a data comparison needs first.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { brainHealthMetrics, collectPerSourceHealth } from "../core/source-health.ts";
import { VERSION } from "../version.ts";
import type { Engine } from "../core/engine/interface.ts";
import { isQuiet, resolveQuiescence } from "../core/quiescence.ts";
import { CYCLE_LOCK_ID } from "../core/db-lock.ts";
import { LEGACY_CYCLE_LOCK_ID, LEGACY_WORKER_LOCK_ID } from "../core/brand.ts";

/**
 * Cycle-lock namespaces and worker-lock ids of both brands. The worker ids are
 * the ones a pre-Lite job worker heartbeats under, and the legacy ones are only read
 * here, so a live older process still blocks `--quiescent`.
 */
const CYCLE_LOCK_NAMESPACES = [CYCLE_LOCK_ID, LEGACY_CYCLE_LOCK_ID];
const WORKER_LOCK_IDS = ["memrain-jobs-worker", LEGACY_WORKER_LOCK_ID];

export interface QuiescenceStatus {
  maintenance: boolean;
  code_sweep: boolean;
  jobs_worker: boolean;
  cycle: boolean;
  jobs_running: number;
  jobs_leased: number;
  live_cycle_locks: number;
  live_worker_lock: number;
  /** Other client sessions on this database; Postgres only, null on PGLite. */
  other_db_sessions: number | null;
}

async function count(engine: Engine, sql: string, params: unknown[] = []): Promise<number> {
  const r = await engine.query<{ c: number }>(sql, params);
  return Number(r.rows[0]?.c ?? 0);
}

export async function readQuiescence(
  engine: Engine,
  env: Record<string, string | undefined> = process.env,
): Promise<QuiescenceStatus> {
  const q = resolveQuiescence(env);
  const jobsRunning = await count(
    engine,
    `SELECT COUNT(*)::int AS c FROM jobs WHERE status = 'running'`,
  );
  const jobsLeased = await count(
    engine,
    `SELECT COUNT(*)::int AS c FROM jobs WHERE status = 'running' AND lock_until > NOW()`,
  );
  const liveCycleLocks = await count(
    engine,
    `SELECT COUNT(*)::int AS c FROM cycle_locks
      WHERE (id = ANY($1::text[]) OR id LIKE ANY($2::text[]))
        AND ttl_expires_at > NOW()`,
    [CYCLE_LOCK_NAMESPACES, CYCLE_LOCK_NAMESPACES.map((n) => `${n}:%`)],
  );
  const liveWorkerLock = await count(
    engine,
    `SELECT COUNT(*)::int AS c FROM worker_lock
      WHERE id = ANY($1::text[])
        AND heartbeat_at > NOW() - (ttl_seconds || ' seconds')::interval`,
    [WORKER_LOCK_IDS],
  );
  const otherSessions =
    engine.kind === "postgres"
      ? await count(
          engine,
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND backend_type = 'client backend'`,
        )
      : null;
  return {
    maintenance: q.maintenance,
    code_sweep: q.bootCodeSweep,
    jobs_worker: q.jobsWorker,
    cycle: q.cycle,
    jobs_running: jobsRunning,
    jobs_leased: jobsLeased,
    live_cycle_locks: liveCycleLocks,
    live_worker_lock: liveWorkerLock,
    other_db_sessions: otherSessions,
  };
}

/** Why `--quiescent` fails; empty when it passes. `other_db_sessions` is a diagnostic only. */
export function quiescentFailures(s: QuiescenceStatus): string[] {
  const failures: string[] = [];
  const quiet = isQuiet({
    maintenance: s.maintenance,
    bootCodeSweep: s.code_sweep,
    jobsWorker: s.jobs_worker,
    cycle: s.cycle,
    invalid: [],
  });
  if (!quiet) failures.push("maintenance off and a background switch on");
  if (s.jobs_running > 0) failures.push(`jobs_running=${s.jobs_running}`);
  if (s.jobs_leased > 0) failures.push(`jobs_leased=${s.jobs_leased}`);
  if (s.live_cycle_locks > 0) failures.push(`live_cycle_locks=${s.live_cycle_locks}`);
  if (s.live_worker_lock > 0) failures.push(`live_worker_lock=${s.live_worker_lock}`);
  return failures;
}

export interface StatusCmdOptions {
  /** Override the config path (tests point this at a temp dir). */
  configPath?: string;
  /** Include the per-source (per-tenant) health breakdown. Local CLI is an
   *  unscoped/trusted caller, so it sees every source incl. '(unclassified)'. */
  perSource?: boolean;
  /** Exit 3 unless the brain is quiescent (see `quiescentFailures`). */
  quiescent?: boolean;
}

/** Prints the snapshot; returns the exit code (3 when `--quiescent` fails). */
export async function runStatus(opts: StatusCmdOptions = {}): Promise<number> {
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.raw();
    // Sequential: the engine may be a single PGLite connection that serializes
    // queries anyway, and these are cheap reads.
    const stats = { ...(await storage.stats()), pages: await storage.pageCount() };
    const oauthClientsLive = await storage.liveOauthClientCount();
    const health = await brainHealthMetrics(engine);
    // Unscoped (no sourceIds) → whole-brain breakdown incl. '(unclassified)'.
    const perSource = opts.perSource
      ? await collectPerSourceHealth(engine)
      : undefined;
    const quiescence = await readQuiescence(engine);
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: VERSION,
          oauth_self_issued: config.auth?.selfIssued?.enabled === true,
          oauth_clients_live: oauthClientsLive,
          stats,
          health,
          ...(perSource ? { perSource } : {}),
          quiescence,
        },
        null,
        2,
      ),
    );
    if (!opts.quiescent) return 0;
    const failures = quiescentFailures(quiescence);
    if (failures.length === 0) return 0;
    console.error(`[memrain] not quiescent: ${failures.join("; ")}`);
    return 3;
  });
}
