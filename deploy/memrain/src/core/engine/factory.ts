/**
 * Engine factory — instantiate by `database.type` from the loaded config.
 *
 * Both adapters share the Engine surface in `interface.ts`. The factory is
 * the only place that imports from `pglite.ts` or `postgres.ts` directly,
 * keeping callers engine-agnostic.
 *
 * The Postgres URL has two override paths so containers can override
 * config.json without touching EFS state:
 *   1. `MEMRAIN_POSTGRES_URL` env  — highest precedence
 *   2. `database.url` field in the JSON config — fallback
 *
 * Pool size and statement timeout are env-tunable so a long migration, a
 * whole-corpus re-embed backfill, or a big rechunk transaction isn't killed at
 * the short interactive `statement_timeout` (default 30s):
 *   - `MEMRAIN_PG_POOL_MAX` (default 10)
 *   - `MEMRAIN_PG_STATEMENT_TIMEOUT_MS` (default 30000)
 *
 * Behind a transaction-mode pooler (`MEMRAIN_PG_POOLER=pgbouncer`) the URL is
 * the pooler's, `MEMRAIN_POSTGRES_DIRECT_URL` the database's own (migrations
 * and DDL), and `MEMRAIN_PG_PREPARE=0` turns named prepared statements off.
 * Both are read only in pooler mode.
 *
 * `MEMRAIN_REQUIRE_POSTGRES=1` makes a pglite config fatal, so a host meant to
 * run on Postgres can never quietly open a local database instead (a missing
 * URL is already fatal). It also covers commands run with `docker exec`.
 */
import type { Config } from "../config.ts";
import type { Engine, PoolerMode } from "./interface.ts";
import { PGliteEngine } from "./pglite.ts";
import { PostgresEngine, type PostgresEngineOptions } from "./postgres.ts";
import { applicationName } from "../pool-budget.ts";

/** Parse a positive-int env override; undefined when unset/invalid (fail-soft). */
function positiveIntEnv(name: string): number | undefined {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * MEMRAIN_PG_POOLER: unset (the default) connects as always; `pgbouncer` puts
 * the engine in pooler mode. Anything else is refused rather than guessed at.
 */
export function poolerMode(env: Record<string, string | undefined> = process.env): PoolerMode | undefined {
  const v = env.MEMRAIN_PG_POOLER;
  if (v === undefined || v === "") return undefined;
  if (v === "pgbouncer") return v;
  throw new Error(`memrain: MEMRAIN_PG_POOLER must be unset or 'pgbouncer', got '${v}'`);
}

/**
 * The pooler half of a Postgres engine's options, from the environment: empty
 * unless MEMRAIN_PG_POOLER is set. Every engine on a pooled tenant's
 * MEMRAIN_POSTGRES_URL needs it, or it sends startup parameters the pooler
 * refuses.
 */
export function poolerEngineOptions(
  env: Record<string, string | undefined> = process.env,
): Pick<PostgresEngineOptions, "pooler" | "directUrl" | "prepare"> {
  const pooler = poolerMode(env);
  if (pooler === undefined) return {};
  const opts: Pick<PostgresEngineOptions, "pooler" | "directUrl" | "prepare"> = { pooler };
  const direct = env.MEMRAIN_POSTGRES_DIRECT_URL;
  if (direct) opts.directUrl = direct;
  if (env.MEMRAIN_PG_PREPARE === "0") opts.prepare = false;
  return opts;
}

/** True when the host must run on Postgres (`MEMRAIN_REQUIRE_POSTGRES=1`). */
export function requirePostgres(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEMRAIN_REQUIRE_POSTGRES === "1";
}

export interface MakeEngineOptions {
  /**
   * The caller picked a throwaway PGLite path itself (tests, bench scratch
   * dirs). That database is never the brain, so the Postgres requirement does
   * not apply to it.
   */
  scratch?: boolean;
}

export function makeEngine(config: Config, opts: MakeEngineOptions = {}): Engine {
  const db = config.database;
  if (db.type === "pglite") {
    if (!opts.scratch && requirePostgres()) {
      throw new Error(
        `memrain: MEMRAIN_REQUIRE_POSTGRES=1 but config.json says database.type=pglite (${db.path}); ` +
          "refusing to open a local database on a Postgres host",
      );
    }
    return new PGliteEngine({ dbPath: db.path });
  }
  if (db.type === "postgres") {
    const url = process.env.MEMRAIN_POSTGRES_URL ?? db.url;
    if (!url) {
      throw new Error(
        "memrain: database.type=postgres but no URL — set MEMRAIN_POSTGRES_URL env or database.url in config.json",
      );
    }
    const opts: PostgresEngineOptions = { url };
    const poolMax = positiveIntEnv("MEMRAIN_PG_POOL_MAX");
    if (poolMax !== undefined) opts.max = poolMax;
    const stmtTimeout = positiveIntEnv("MEMRAIN_PG_STATEMENT_TIMEOUT_MS");
    if (stmtTimeout !== undefined) opts.statementTimeoutMs = stmtTimeout;
    const appName = applicationName();
    if (appName !== undefined) opts.applicationName = appName;
    return new PostgresEngine({ ...opts, ...poolerEngineOptions() });
  }
  throw new Error(
    `memrain: unknown database.type ${(db as { type: string }).type}`,
  );
}
