/**
 * `memrain migrate-engine --from pglite|postgres --to pglite|postgres`
 *
 * Copies a whole brain between engines and proves the copy:
 *   1. Open both engines; apply migrations on the destination.
 *   2. Read both catalogs and copy every public table in FK order (column
 *      intersection, generated columns skipped), keyset-batched, with
 *      triggers and FK checks off so no insert rewrites a copied row.
 *      Keyed tables upsert, so a re-run resumes and converges.
 *   3. Verify each table by row count and content hash; any mismatch,
 *      missing table, failed table or source-only column makes the run
 *      fail (exit 1).
 *
 * Steps 2 and 3 read the source through one REPEATABLE READ snapshot, so a
 * source that keeps taking writes is copied and checked as one point in time.
 *
 * The source is only read. pglite→pglite (two paths) is allowed, which makes
 * Postgres→PGLite→Postgres a checkable rollback rehearsal.
 *
 * `--dry-run` reads catalogs and counts and writes nothing. `--verify-only`
 * runs step 3 alone against two existing databases.
 *
 * Every mode refuses a source whose schema is behind this binary: the
 * destination is migrated to the current schema, so an older source would copy
 * into columns and tables it never had, and a rollback rehearsal would pass on
 * data no current brain holds.
 */
import { resolve } from "node:path";
import { PGliteEngine } from "../core/engine/pglite.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { discoverMigrations, runMigrations } from "../core/migrate.ts";
import { copyEngine, type CopySummary } from "../core/engine-copy.ts";
import type { Engine } from "../core/engine/interface.ts";

export interface MigrateEngineOptions {
  from: "pglite" | "postgres";
  to: "pglite" | "postgres";
  /** Source PGLite path; also the destination when only one pglite endpoint is used. */
  pgliteDbPath?: string;
  /** Destination PGLite path — required for pglite→pglite. */
  toPgliteDbPath?: string;
  postgresUrl?: string;
  dryRun?: boolean;
  verifyOnly?: boolean;
  tables?: string[];
  /** Rows per copy batch. Default 500. */
  batchSize?: number;
  /** Pass when a source column the destination lacks may be dropped. */
  allowDroppedColumns?: boolean;
}

export type Endpoint =
  | { kind: "pglite"; path: string }
  | { kind: "postgres"; url: string };

export function resolveEndpoints(
  opts: MigrateEngineOptions,
  env: Record<string, string | undefined> = process.env,
): { src: Endpoint; dst: Endpoint } {
  if (opts.from === opts.to && opts.from !== "pglite") {
    throw new Error("migrate-engine: --from and --to must differ (only pglite→pglite may repeat)");
  }
  const pglite = (p: string | undefined, flag: string): Endpoint => {
    if (!p) throw new Error(`migrate-engine: ${flag} required for pglite endpoint`);
    return { kind: "pglite", path: resolve(p) };
  };
  const postgresEp = (): Endpoint => {
    const url = opts.postgresUrl ?? env.MEMRAIN_POSTGRES_URL;
    if (!url) {
      throw new Error(
        "migrate-engine: --postgres-url or MEMRAIN_POSTGRES_URL required for postgres endpoint",
      );
    }
    return { kind: "postgres", url };
  };
  const src = opts.from === "pglite" ? pglite(opts.pgliteDbPath, "--pglite-path") : postgresEp();
  const dst = opts.to === "postgres"
    ? postgresEp()
    : opts.from === "pglite"
      ? pglite(opts.toPgliteDbPath, "--to-pglite-path")
      : pglite(opts.toPgliteDbPath ?? opts.pgliteDbPath, "--pglite-path");
  const same = src.kind === "pglite" && dst.kind === "pglite"
    ? src.path === dst.path
    : src.kind === "postgres" && dst.kind === "postgres" && src.url === dst.url;
  if (same) {
    throw new Error("migrate-engine: source and destination are the same database");
  }
  return { src, dst };
}

/** Throw when the source has not applied every migration this binary ships. */
export async function assertSourceSchemaCurrent(src: Engine): Promise<void> {
  const fix = "run `memrain apply-migrations` against the source first, then retry";
  let applied: Set<number>;
  try {
    const r = await src.query<{ id: number }>("SELECT id::int AS id FROM migrations");
    applied = new Set(r.rows.map((row) => Number(row.id)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`migrate-engine: cannot read the source schema version (${msg}); ${fix}`);
  }
  const pending = discoverMigrations().map((m) => m.id).filter((id) => !applied.has(id));
  if (pending.length > 0) {
    throw new Error(
      `migrate-engine: source schema is behind this binary (${pending.length} migration(s) unapplied, ` +
        `first ${Math.min(...pending)}); ${fix}`,
    );
  }
}

function openEngine(ep: Endpoint): Engine {
  return ep.kind === "pglite"
    ? new PGliteEngine({ dbPath: ep.path })
    : new PostgresEngine({ url: ep.url });
}

export async function runMigrateEngine(opts: MigrateEngineOptions): Promise<CopySummary> {
  const { src: srcEp, dst: dstEp } = resolveEndpoints(opts);
  const src = openEngine(srcEp);
  let dst: Engine | undefined;
  try {
    dst = openEngine(dstEp);
    const mode = opts.dryRun ? "dry-run" : opts.verifyOnly ? "verify-only" : "copy";
    console.error(`[migrate-engine] from=${opts.from} to=${opts.to} mode=${mode}`);
    await src.ready();
    await assertSourceSchemaCurrent(src);
    await dst.ready();

    if (!opts.dryRun && !opts.verifyOnly) {
      console.error("[migrate-engine] applying migrations on destination …");
      const m = await runMigrations(dst);
      console.error(`  applied=${m.applied.length} skipped=${m.skipped}`);
    }

    const summary = await copyEngine(src, dst, {
      tables: opts.tables,
      batchSize: opts.batchSize,
      dryRun: opts.dryRun,
      verifyOnly: opts.verifyOnly,
      allowDroppedColumns: opts.allowDroppedColumns,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify({ ...summary, completedAt: new Date().toISOString() }, null, 2));
    return summary;
  } finally {
    await src.close();
    await dst?.close();
  }
}
