/**
 * The one place a test builds a Postgres engine. `scripts/test-pg.sh` with
 * TEST_PG_POOLER=1 hands pooled files MEMRAIN_TEST_POSTGRES_URL pointing at a
 * PgBouncer in transaction mode, plus MEMRAIN_TEST_POSTGRES_DIRECT_URL (the
 * database itself), MEMRAIN_TEST_PG_POOLER=pgbouncer and
 * MEMRAIN_TEST_PG_PREPARE. An engine on the pooler's address then runs in
 * pooler mode, exactly as the hosting containers do, with the direct address
 * of the same database for its migrations. Any other URL (a direct-only file,
 * or no pooler at all) gets a plain engine.
 */
import { PostgresEngine, type PostgresEngineOptions } from "../../src/core/engine/postgres.ts";

const POOLED = process.env["MEMRAIN_TEST_POSTGRES_URL"];
const DIRECT = process.env["MEMRAIN_TEST_POSTGRES_DIRECT_URL"];
const POOLER = process.env["MEMRAIN_TEST_PG_POOLER"] === "pgbouncer" ? "pgbouncer" as const : undefined;

/** True while this file runs through the test pooler. */
export const TEST_PG_POOLED = POOLER !== undefined && POOLED !== undefined && DIRECT !== undefined;

function endpoint(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}`;
}

/** `url` with the pooler's host and port swapped for the database's own. */
export function directUrlOf(url: string): string {
  if (!TEST_PG_POOLED || endpoint(url) !== endpoint(POOLED!)) return url;
  const u = new URL(url);
  const d = new URL(DIRECT!);
  u.hostname = d.hostname;
  u.port = d.port;
  return u.toString();
}

/** The environment a `memrain` child process needs to open `url` the same way. */
export function pgTestEnv(url: string): Record<string, string> {
  if (!TEST_PG_POOLED || endpoint(url) !== endpoint(POOLED!)) return { MEMRAIN_POSTGRES_URL: url };
  return {
    MEMRAIN_POSTGRES_URL: url,
    MEMRAIN_PG_POOLER: POOLER!,
    MEMRAIN_POSTGRES_DIRECT_URL: directUrlOf(url),
    ...(process.env["MEMRAIN_TEST_PG_PREPARE"] === "0" ? { MEMRAIN_PG_PREPARE: "0" } : {}),
  };
}

export function pgTestEngine(opts: PostgresEngineOptions): PostgresEngine {
  if (!TEST_PG_POOLED || endpoint(opts.url) !== endpoint(POOLED!)) return new PostgresEngine(opts);
  return new PostgresEngine({
    ...opts,
    pooler: POOLER,
    directUrl: directUrlOf(opts.url),
    ...(process.env["MEMRAIN_TEST_PG_PREPARE"] === "0" ? { prepare: false } : {}),
  });
}
