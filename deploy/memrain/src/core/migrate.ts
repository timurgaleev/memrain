/**
 * Versioned migration engine.
 *
 * Loads migration files from `src/core/migrations/NNN_<name>.sql`, sorts
 * by the numeric prefix, applies any not yet recorded in the `migrations`
 * table. Each migration runs in its own implicit transaction (PGLite's
 * `exec` wraps multi-statement SQL).
 *
 * Filename grammar:
 *   <id:integer, zero-padded>_<slug>.sql
 *   e.g. 001_initial.sql, 002_entities.sql, 010_email_sources.sql
 *
 * The engine is intentionally append-only: never edit a shipped
 * migration in-place — write a new one. Same rule as Rails / sqlx /
 * Diesel migrations.
 */
import type { Engine } from "./engine/interface.ts";
import { isRetryableConnError, isStatementTimeoutError } from "./retry.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(__dirname, "migrations");
const DEFAULT_DOWN_DIR = resolve(__dirname, "migrations-down");

export interface MigrationFile {
  id: number;
  name: string;
  filename: string;
  sql: string;
}

export interface MigrationResult {
  applied: { id: number; name: string }[];
  skipped: number;
}

const FILENAME_RE = /^(\d+)_([\w-]+)\.sql$/;
const DOWN_FILENAME_RE = /^(\d+)_([\w-]+)\.down\.sql$/;

/**
 * Per-migration lock timeout. A DDL `ALTER`/`ADD COLUMN` takes a brief
 * `ACCESS EXCLUSIVE` lock; if a long-running query holds a conflicting
 * lock the migration would otherwise block indefinitely and hang the
 * deploy. `SET LOCAL` scopes this to the migration transaction (resets
 * on commit/rollback) so a stuck migration fails fast instead. Harmless
 * on PGLite (single-connection, no lock contention); the value matters
 * on live RDS. Surfaced by the P0 migration review.
 *
 * Default is forgiving enough to ride out a brief transient lock holder
 * without breaking the deploy, yet bounded so it can't hang forever.
 * Override with `MEMRAIN_MIGRATION_LOCK_TIMEOUT` (e.g. `60s`, `5min`) for a
 * one-off migration that must wait behind a known long transaction.
 */
const DEFAULT_LOCK_TIMEOUT = "10s";

// Postgres `lock_timeout` grammar: a bare integer is milliseconds, or an
// integer with a time unit. We accept the common units only.
const LOCK_TIMEOUT_RE = /^\d+\s*(?:ms|min|[shd])?$/;

/**
 * Resolve the per-migration lock timeout, validating any env override.
 * Throws on a malformed value rather than silently falling back — a
 * typo'd timeout should fail the deploy loudly, not mask the operator's
 * intent (e.g. a misspelled `5min` quietly running at the default).
 */
export function resolveLockTimeout(
  env: string | undefined = process.env.MEMRAIN_MIGRATION_LOCK_TIMEOUT,
): string {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_LOCK_TIMEOUT;
  if (!LOCK_TIMEOUT_RE.test(v)) {
    throw new Error(
      `MEMRAIN_MIGRATION_LOCK_TIMEOUT is malformed: ${JSON.stringify(v)} ` +
        `(expected e.g. "10s", "500ms", "5min")`,
    );
  }
  return v;
}

// A migration runs under a generous statement_timeout so a large ADD COLUMN
// backfill or CREATE INDEX isn't killed at the short interactive limit (30s).
// Applied as a transaction-scoped `SET LOCAL`, so it never leaks to normal
// queries. The engine session's own statement_timeout (MEMRAIN_PG_STATEMENT_TIMEOUT_MS)
// still governs interactive traffic.
const DEFAULT_MIGRATION_STMT_TIMEOUT = "30min";

/**
 * Resolve the per-migration statement timeout, validating any env override.
 * Same fail-loud policy as {@link resolveLockTimeout}.
 */
export function resolveMigrationStatementTimeout(
  env: string | undefined = process.env.MEMRAIN_MIGRATION_STATEMENT_TIMEOUT,
): string {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_MIGRATION_STMT_TIMEOUT;
  if (!LOCK_TIMEOUT_RE.test(v)) {
    throw new Error(
      `MEMRAIN_MIGRATION_STATEMENT_TIMEOUT is malformed: ${JSON.stringify(v)} ` +
        `(expected e.g. "30min", "600s", "1800000")`,
    );
  }
  return v;
}

/**
 * Discover migration files in a directory. Returns them sorted by id ascending.
 * Throws if a filename doesn't match the grammar so we never silently skip
 * a typo'd migration.
 */
export function discoverMigrations(dir: string = DEFAULT_DIR): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const out: MigrationFile[] = [];
  for (const filename of entries) {
    const m = FILENAME_RE.exec(filename);
    if (!m) {
      throw new Error(
        `migration filename does not match NNN_name.sql grammar: ${filename}`,
      );
    }
    const id = Number.parseInt(m[1]!, 10);
    const name = m[2]!;
    const sql = readFileSync(resolve(dir, filename), "utf8");
    out.push({ id, name, filename, sql });
  }
  out.sort((a, b) => a.id - b.id);
  // Detect duplicate ids — easy to typo when copy-pasting.
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.id === out[i - 1]!.id) {
      throw new Error(
        `duplicate migration id ${out[i]!.id}: ${out[i - 1]!.filename} vs ${out[i]!.filename}`,
      );
    }
  }
  return out;
}

export interface MigrationDrift {
  /** Recorded in the DB but unknown to this build — the image is older than the schema. */
  ahead: number[];
  /** Known to this build, not recorded, and below the highest applied id. */
  gaps: number[];
  /** Known to this build, not recorded, and above the highest applied id. */
  pending: number[];
}

/**
 * Compare the applied migration ids against the ones this build ships. A
 * MAX(id)-only comparison calls a rolled-back image "up to date" when the DB
 * already carries migrations the image has never seen; comparing the full sets
 * separates that from ordinary pending work and from holes in the history.
 */
export function diffMigrationIds(
  appliedIds: Iterable<number>,
  availableIds: Iterable<number>,
): MigrationDrift {
  const applied = new Set(appliedIds);
  const available = new Set(availableIds);
  const maxApplied = applied.size > 0 ? Math.max(...applied) : 0;
  const ahead = [...applied].filter((id) => !available.has(id)).sort((a, b) => a - b);
  const unapplied = [...available].filter((id) => !applied.has(id)).sort((a, b) => a - b);
  return {
    ahead,
    gaps: unapplied.filter((id) => id < maxApplied),
    pending: unapplied.filter((id) => id > maxApplied),
  };
}

/**
 * A connection stuck `idle in transaction` can hold the lock a DDL migration
 * needs. Surface such blockers so the operator has a paste-ready
 * `pg_terminate_backend(<pid>)` when a migration retries or exhausts.
 * Postgres-only; returns `[]` on PGLite or if `pg_stat_activity` is restricted
 * (some managed configs deny it — a partial view still helps).
 */
export interface IdleBlocker {
  pid: number;
  state: string;
  query_start: string;
  query: string;
}

export async function getIdleBlockers(engine: Engine): Promise<IdleBlocker[]> {
  if (engine.kind !== "postgres") return [];
  try {
    const res = await engine.query<IdleBlocker>(
      `SELECT pid, state, query_start::text AS query_start,
              substring(query, 1, 120) AS query
         FROM pg_stat_activity
        WHERE state = 'idle in transaction'
          AND query_start < NOW() - INTERVAL '5 minutes'
          AND pid != pg_backend_pid()`,
    );
    return res.rows;
  } catch {
    return [];
  }
}

/**
 * Retry-exhausted envelope: names the idle blocker most likely holding the
 * lock so the failure message carries a paste-ready recovery command.
 */
export class MigrationRetryExhausted extends Error {
  constructor(
    public readonly id: number,
    public readonly migrationName: string,
    public readonly attempts: number,
    public readonly lastBlockers: IdleBlocker[],
    public readonly lastError: Error,
  ) {
    const b = lastBlockers[0];
    const hint = b
      ? `PID ${b.pid} idle since ${b.query_start} likely holds the lock; run: SELECT pg_terminate_backend(${b.pid})`
      : "no idle-in-transaction blockers detected; check pg_locks for active waiters";
    super(
      `migration ${id} (${migrationName}) failed after ${attempts} attempt(s). ` +
        `${hint}. Original: ${lastError.message}`,
    );
    this.name = "MigrationRetryExhausted";
  }
}

// Retry cadence for a migration that trips a transient statement_timeout or a
// connection reset (5s / 15s / 45s). MEMRAIN_MIGRATE_BACKOFF_MS collapses it to a
// fixed delay so the retry path is unit-testable in milliseconds; unset in
// production, where the real cadence applies.
function migrationBackoffs(): number[] {
  const override = process.env.MEMRAIN_MIGRATE_BACKOFF_MS;
  if (override !== undefined) {
    const ms = Number.parseInt(override, 10) || 0;
    return [ms, ms, ms];
  }
  return [5000, 15000, 45000];
}

/**
 * Apply one migration's SQL + bookkeeping INSERT in a single transaction, with
 * a 3-attempt retry on a transient statement_timeout (57014) or connection
 * reset. The whole transaction rolls back on failure, so a retry re-runs it
 * atomically — nothing is half-recorded. A lock_timeout (55P03) stays
 * fail-fast (not retryable): a held lock won't clear by re-waiting. Wraps
 * memrain's bundled-transaction runner so the SQL + bookkeeping INSERT retry
 * atomically.
 */
async function applyOneWithRetry(
  engine: Engine,
  f: MigrationFile,
  lockTimeout: string,
  stmtTimeout: string,
): Promise<boolean> {
  const backoffs = migrationBackoffs();
  let lastErr: Error | null = null;
  let lastBlockers: IdleBlocker[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      lastBlockers = await getIdleBlockers(engine);
      if (lastBlockers.length > 0) {
        console.warn(
          `  [retry ${attempt}/3] ${lastBlockers.length} idle-in-transaction blocker(s):`,
        );
        for (const b of lastBlockers) {
          console.warn(
            `    PID ${b.pid} idle since ${b.query_start} — ${b.query.slice(0, 80)}`,
          );
        }
      }
    }
    try {
      const applied = await engine.transaction(async (tx) => {
        // `serve` and a `docker exec memrain …` CLI both run migrations. Each read
        // the applied set up front, so two of them racing both applied the same
        // file and the loser died on the duplicate `migrations` row — at boot.
        // One migration at a time across processes, and the second finds it
        // done. Taken before the migration's own lock_timeout so a waiter is not
        // cut off by a long migration next door.
        // The connection's own statement_timeout (30 s on the pool) would
        // otherwise cut the wait short while a long migration holds the lock —
        // the very failure this lock exists to prevent — so the migration's
        // timeout is set first.
        await tx.exec(`SET LOCAL statement_timeout = '${stmtTimeout}';`);
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'))");
        const done = await tx.query("SELECT 1 FROM migrations WHERE id = $1", [f.id]);
        if (done.rows.length > 0) return false;
        await tx.exec(`SET LOCAL lock_timeout = '${lockTimeout}';`);
        await tx.exec(f.sql);
        await tx.query("INSERT INTO migrations (id, name) VALUES ($1, $2)", [
          f.id,
          f.name,
        ]);
        return true;
      });
      return applied;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Commit-ambiguity edge: a connection reset landing AFTER the server
      // committed but before the client saw the ack re-runs the SQL, which
      // then errors (non-idempotent DDL, or a duplicate-PK 23505 on the
      // bookkeeping INSERT) — a non-retryable failure that surfaces loudly.
      // The next deploy skips the already-recorded id, so the state is clean.
      const retryable = isStatementTimeoutError(err) || isRetryableConnError(err);
      if (!retryable || attempt === 2) {
        if (retryable) {
          lastBlockers = await getIdleBlockers(engine);
          throw new MigrationRetryExhausted(
            f.id,
            f.name,
            attempt + 1,
            lastBlockers,
            lastErr,
          );
        }
        throw err;
      }
      const delay = backoffs[attempt]!;
      console.warn(
        `  [retry ${attempt + 1}/3] migration ${f.id} (${f.name}) hit ` +
          `${lastErr.message.slice(0, 80)}; retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Defensive: the loop returns or throws on every path.
  throw lastErr ?? new Error(`migration ${f.id} (${f.name}) did not run`);
}

/**
 * Apply pending migrations. Idempotent. Bootstraps the migrations table
 * itself before the first real migration runs.
 *
 * The engine adds a `name` column on top of the original schema
 * (which only had `id` + `applied_at`). The ALTER runs unconditionally;
 * Postgres / PGLite both treat IF NOT EXISTS as a no-op.
 */
export async function runMigrations(
  engine: Engine,
  dir: string = DEFAULT_DIR,
): Promise<MigrationResult> {
  await engine.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE migrations ADD COLUMN IF NOT EXISTS name TEXT;
  `);

  const seenRows = await engine.query<{ id: number }>(
    "SELECT id FROM migrations ORDER BY id",
  );
  const seen = new Set(seenRows.rows.map((r) => r.id));

  const files = discoverMigrations(dir);
  const lockTimeout = resolveLockTimeout();
  const stmtTimeout = resolveMigrationStatementTimeout();
  const applied: { id: number; name: string }[] = [];
  let skipped = 0;

  for (const f of files) {
    if (seen.has(f.id)) {
      skipped++;
      continue;
    }
    // Apply the migration SQL and the bookkeeping INSERT inside one
    // transaction. A crash between the two (process kill, power loss,
    // pglite I/O error) used to leave the migration physically applied
    // but unrecorded — on next boot the same SQL re-ran, breaking any
    // non-idempotent change (column rename, data backfill). With both
    // in one tx, the migration is either fully applied + recorded or
    // entirely rolled back; PGLite and postgres-js both support
    // transactional DDL on the surfaces we use. The transaction is retried
    // on a transient statement_timeout / connection reset (see
    // applyOneWithRetry); a rolled-back attempt records nothing.
    if (await applyOneWithRetry(engine, f, lockTimeout, stmtTimeout)) {
      applied.push({ id: f.id, name: f.name });
    } else {
      skipped++;
    }
  }

  return { applied, skipped };
}

/**
 * The down file of migration `id` (`migrations-down/NNN_<name>.down.sql`).
 * Only a migration that ships one can be reverted.
 */
export function findDownMigration(id: number, dir: string = DEFAULT_DOWN_DIR): MigrationFile {
  const hits: MigrationFile[] = [];
  for (const filename of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const m = DOWN_FILENAME_RE.exec(filename);
    if (!m) {
      throw new Error(`down migration filename does not match NNN_name.down.sql grammar: ${filename}`);
    }
    if (Number.parseInt(m[1]!, 10) !== id) continue;
    hits.push({ id, name: m[2]!, filename, sql: readFileSync(resolve(dir, filename), "utf8") });
  }
  if (hits.length !== 1) {
    throw new Error(
      hits.length === 0
        ? `migration ${id} has no down file in ${dir}`
        : `migration ${id} has ${hits.length} down files: ${hits.map((h) => h.filename).join(", ")}`,
    );
  }
  return hits[0]!;
}

/**
 * Revert the latest applied migration with its down file, in one transaction.
 * Refuses any other id: a down undoes exactly what its migration added, so it
 * is only defined on top of it. The down file checks its own preconditions as
 * well (psql runs it without this code) and raises before changing anything.
 */
export async function revertMigration(
  engine: Engine,
  id: number,
  dir: string = DEFAULT_DOWN_DIR,
): Promise<{ id: number; name: string }> {
  const down = findDownMigration(id, dir);
  const top = await engine.query<{ id: number | null }>("SELECT max(id) AS id FROM migrations");
  const latest = top.rows[0]?.id ?? null;
  if (latest === null || Number(latest) !== id) {
    throw new Error(
      `migration ${id} is not the latest applied migration (latest: ${latest ?? "none"}); only the latest can be reverted`,
    );
  }
  await engine.transaction(async (tx) => {
    await tx.exec(down.sql);
  });
  return { id, name: down.name };
}
