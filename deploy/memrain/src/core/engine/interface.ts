/**
 * Engine interface — common surface for PGLite and Postgres adapters.
 *
 * Both engines speak the same Postgres SQL dialect (we only use what's
 * portable between them). The interface is intentionally narrow:
 *
 *   - query<T>: read or write returning rows; uses $1, $2 placeholders
 *   - exec:    fire-and-forget multi-statement DDL or transaction control
 *   - ready:   wait for the underlying client to finish init
 *   - close:   release the connection / pool
 *
 * Higher-level state (transactions, prepared statements, batches) is
 * orchestrated at the call site and works because both engines support
 * standard SQL `BEGIN` / `COMMIT` / `ROLLBACK`.
 */

export type EngineKind = "pglite" | "postgres";

/** The transaction-mode pooler an engine connects through (MEMRAIN_PG_POOLER). */
export type PoolerMode = "pgbouncer";

export interface QueryResult<T = unknown> {
  rows: T[];
}

export interface Engine {
  /** Adapter discriminator — use it to gate engine-specific code paths. */
  readonly kind: EngineKind;

  /**
   * Set when the engine reaches the database through a transaction-mode
   * pooler: migrations and DDL then need `openDirect()` (core/engine/direct.ts).
   */
  readonly pooler?: PoolerMode;

  /**
   * On a transaction handle: the engine it was opened from. Per-engine caches
   * (schema probes) key on this, so a probe inside a transaction is shared
   * with the pool instead of repeated per transaction.
   */
  readonly root?: Engine;

  /** A direct engine for migrations and DDL; only a pooled engine has one. */
  openDirect?(): Engine;

  /** Wait until the engine is ready to accept queries. */
  ready(): Promise<void>;

  /**
   * Run a single SQL statement with optional positional parameters.
   * Returns rows in PGLite-shaped envelope: `{ rows: T[] }`.
   * Engine adapters normalise their native return types to this shape.
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /**
   * Execute SQL without expecting parameter binding or row return.
   * Used for migrations and transaction-control statements.
   * Adapters route this through their statement-batching path so
   * multi-statement input works (PGLite's exec / postgres-js simple).
   */
  exec(sql: string): Promise<void>;

  /** Release client / pool. Idempotent. */
  close(): Promise<void>;

  /**
   * Run `fn` inside a transaction. The callback receives an Engine
   * handle scoped to the in-flight transaction — use it for queries
   * that must commit/rollback together. Throws → rollback; returns →
   * commit. Nesting is NOT supported (PGLite is single-connection;
   * postgres-js's begin() doesn't let us nest cleanly either).
   *
   * Why this exists: postgres-js refuses inline `BEGIN`/`COMMIT` via
   * `exec()` with `UNSAFE_TRANSACTION`. PGLite accepts it. The Engine
   * interface unifies them so callers don't branch on `kind`.
   */
  transaction<T>(fn: (tx: Engine) => Promise<T>): Promise<T>;
}
