/**
 * Postgres engine — wraps `postgres` (postgres-js) with TLS + pool.
 *
 * Activated when `database.type === "postgres"` in config. Connection
 * URL is read from the secret `<secrets_prefix>/memrain-postgres-url`
 * (mounted at runtime via fetch-secrets.sh) and exposed as MEMRAIN_POSTGRES_URL
 * env. RDS-managed Postgres assumed; pgvector + pg_trgm extensions must
 * be enabled at instance level (see terraform/rds.tf).
 *
 * ships the actual RDS provisioning + migrate-engine command;
 * this adapter exists earlier so the rest of the codebase can be written
 * once against the Engine interface.
 */
import postgres, { type Sql } from "postgres";
import type { Engine, QueryResult } from "./interface.ts";

export interface PostgresEngineOptions {
  /** Postgres connection URL. Should include `?sslmode=require` for RDS. */
  url: string;
  /** Pool size. Default 10 — fits a single memrain container. */
  max?: number;
  /** Per-statement timeout, ms. Default 30s. */
  statementTimeoutMs?: number;
  /** `application_name` shown in pg_stat_activity; postgres-js's default when unset. */
  applicationName?: string;
}

export class PostgresEngine implements Engine {
  readonly kind = "postgres" as const;
  private sql: Sql;

  constructor(opts: PostgresEngineOptions) {
    const max = opts.max ?? 10;
    const statementTimeout = opts.statementTimeoutMs ?? 30_000;
    this.sql = postgres(opts.url, {
      max,
      // RDS requires TLS; postgres-js infers `ssl: true` when the URL has
      // `sslmode=require`, but be explicit so it doesn't silently fall back
      // to plaintext when someone fat-fingers the URL.
      ssl: opts.url.includes("sslmode=disable") ? false : "require",
      idle_timeout: 30,
      // Fail a connect in bounded time instead of hanging a request on a dead
      // endpoint.
      connect_timeout: 10,
      connection: {
        // Each session inherits this; ensures a runaway query can't pin a
        // worker forever.
        statement_timeout: statementTimeout,
        // statement_timeout never fires between statements, so a transaction
        // left idle — its caller wedged mid-way — would keep its locks forever.
        // Page writes hold a per-slug advisory lock for their transaction, so
        // that would freeze every write to the slug. End such a session.
        idle_in_transaction_session_timeout: 60_000,
        ...(opts.applicationName ? { application_name: opts.applicationName } : {}),
      },
      // Suppress the default debug logger; we route via the cycle / progress
      // channels instead.
      onnotice: () => {},
    });
  }

  async ready(): Promise<void> {
    // postgres-js connects lazily on the first query. Force a no-op round
    // trip so transient DNS / TLS failures surface at startup, not first use.
    await this.sql`SELECT 1`;
  }

  async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    // `unsafe` accepts a parameterised string with $1 / $2 placeholders, the
    // same shape PGLite uses. The result is array-like with a `count`
    // field — we copy the rows out so the caller sees a plain `{ rows }`.
    const r = await this.sql.unsafe<T[]>(sql, params as never[]);
    return { rows: Array.from(r) as T[] };
  }

  async exec(sql: string): Promise<void> {
    // `simple()` switches the protocol to "simple query" so multi-statement
    // SQL (BEGIN; ...; COMMIT) executes as one round trip — that matches
    // PGLite's `exec()` semantics.
    await this.sql.unsafe(sql).simple();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async transaction<T>(fn: (tx: Engine) => Promise<T>): Promise<T> {
    // postgres-js refuses inline BEGIN/COMMIT via exec() with
    // `UNSAFE_TRANSACTION`. Its sql.begin() is the supported path.
    // We wrap the inner sub-sql in an Engine façade so callers can
    // use the same shape across both adapters.
    return this.sql.begin(async (sql) => {
      const tx: Engine = {
        kind: "postgres",
        async ready() {
          /* noop — already inside an open transaction */
        },
        async query<U = unknown>(
          text: string,
          params: unknown[] = [],
        ): Promise<QueryResult<U>> {
          const r = await sql.unsafe<U[]>(text, params as never[]);
          return { rows: Array.from(r) as U[] };
        },
        async exec(text: string): Promise<void> {
          await sql.unsafe(text).simple();
        },
        async close() {
          /* noop — outer .end() owns the connection */
        },
        async transaction<T2>(_inner: (e: Engine) => Promise<T2>): Promise<T2> {
          throw new Error(
            "postgres engine: nested transactions not supported",
          );
        },
      };
      return fn(tx);
    }) as Promise<T>;
  }

  /** Escape hatch — used by phase-10 migrate-engine. */
  rawSql(): Sql {
    return this.sql;
  }
}
