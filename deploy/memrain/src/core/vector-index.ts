/**
 * pgvector HNSW index lifecycle manager.
 *
 * The HNSW index lifecycle surface for memrain's stack:
 *   - `Engine` (query/exec/transaction). CONCURRENTLY routes through
 *     `engine.exec` — its simple-query protocol runs a single statement outside
 *     any transaction, which is exactly what `CREATE INDEX CONCURRENTLY` needs
 *     (`engine.query` uses the extended protocol, which CONCURRENTLY rejects).
 *   - memrain's real HNSW index: `embeddings_vector_idx` on `embeddings(vector)`
 *     (migration 001).
 *   - RDS — the external-maintenance detector matches the managed app names
 *     memrain could see (rdsadmin / autovacuum / pg_cron).
 *
 * The functions:
 *   - checkActiveBuild:   pre-op probe of pg_stat_activity.
 *   - dropZombieIndexes:  sweep of indisvalid=false indexes, guarded against an
 *                         in-flight build (an aborted CONCURRENTLY leaves one).
 *   - dropAndRebuild:     atomic-swap rebuild — build a temp index CONCURRENTLY,
 *                         then DROP old + RENAME temp in one transaction. If the
 *                         build fails, the old index stays intact and search
 *                         keeps serving.
 *   - monitorBuild:       poll progress of a long-running build.
 *
 * All Postgres-only; every function no-ops (or returns empty) on PGLite, which
 * is single-connection and has no pg_stat_activity / concurrent-build surface.
 */
import type { Engine } from "./engine/interface.ts";
import type { EmbeddingVectorType } from "./embedding-column.ts";

/**
 * ef_search must cover the requested ANN candidate pool: pgvector's HNSW scan
 * gathers at most `hnsw.ef_search` rows (default 40) BEFORE the LIMIT, so a
 * larger LIMIT silently truncates. Clamped to pgvector's [1..1000] bound;
 * callers only need to set the GUC when this exceeds the default 40.
 */
export function hnswEfSearchFor(limit: number): number {
  return Math.min(1000, Math.max(40, limit));
}

/** memrain's production HNSW index (migration 001; halfvec opclass since 191). */
export const EMBEDDINGS_HNSW_INDEX = "embeddings_vector_idx";

/**
 * The production index spec for the column's storage type: the operator class
 * must match the column (`vector_cosine_ops` refuses a halfvec column).
 */
export function embeddingsHnswSpec(type: EmbeddingVectorType): IndexSpec {
  return {
    name: EMBEDDINGS_HNSW_INDEX,
    table: "embeddings",
    column: "vector",
    using: `hnsw (vector ${type === "halfvec" ? "halfvec_cosine_ops" : "vector_cosine_ops"})`,
  };
}

export interface IndexSpec {
  /** The CURRENT (production) index name. */
  name: string;
  table: string;
  column: string;
  /** USING clause body — e.g. `hnsw (vector halfvec_cosine_ops)`. */
  using: string;
  /** Optional WHERE predicate (without the WHERE keyword). */
  condition?: string;
}

export interface ActiveBuildInfo {
  active: boolean;
  pid?: number;
  query?: string;
  application_name?: string;
}

/**
 * Probe pg_stat_activity for an active CREATE INDEX / REINDEX on this index.
 * A pre-op guard so dropAndRebuild doesn't compete with a build already in
 * flight (RDS auto-maintenance or a parallel memrain process).
 */
export async function checkActiveBuild(
  engine: Engine,
  indexName: string,
): Promise<ActiveBuildInfo> {
  if (engine.kind !== "postgres") return { active: false };
  try {
    const r = await engine.query<{
      pid: number;
      query: string;
      application_name: string | null;
    }>(
      `SELECT pid, query, application_name
         FROM pg_stat_activity
        WHERE state = 'active'
          AND (query ILIKE $1 OR query ILIKE $2)
          AND pid != pg_backend_pid()
        LIMIT 1`,
      [`%CREATE INDEX%${indexName}%`, `%REINDEX%${indexName}%`],
    );
    if (r.rows.length === 0) return { active: false };
    const row = r.rows[0]!;
    return {
      active: true,
      pid: row.pid,
      query: row.query,
      application_name: row.application_name ?? undefined,
    };
  } catch {
    // pg_stat_activity may be restricted on some managed tiers — fail open.
    return { active: false };
  }
}

/**
 * Sweep invalid indexes: drop any pg_index row with indisvalid=false on the
 * given tables, UNLESS a build is active for that index (an aborted
 * CONCURRENTLY leaves an invalid index Postgres keeps but never plans with, so
 * lookups silently seq-scan). Postgres-only; PGLite returns { dropped: [] }.
 */
export async function dropZombieIndexes(
  engine: Engine,
  tableNames: string[] = ["embeddings", "chunks", "pages", "documents"],
): Promise<{ dropped: string[] }> {
  if (engine.kind !== "postgres") return { dropped: [] };
  const dropped: string[] = [];
  try {
    const r = await engine.query<{ indexname: string; tablename: string }>(
      `SELECT i.relname AS indexname, t.relname AS tablename
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE ix.indisvalid = false
          AND n.nspname = 'public'
          AND t.relname = ANY($1)`,
      [tableNames],
    );
    for (const row of r.rows) {
      const active = await checkActiveBuild(engine, row.indexname);
      if (active.active) {
        console.error(
          `[hnsw] skipping zombie cleanup of ${row.indexname} — active build (pid ${active.pid})`,
        );
        continue;
      }
      try {
        // Identifier is a pg_class relname read back from the catalog, not
        // caller input — safe to interpolate (DROP INDEX takes no parameters).
        await engine.exec(`DROP INDEX IF EXISTS "${row.indexname}"`);
        dropped.push(row.indexname);
        console.error(
          `[hnsw] dropped zombie index ${row.indexname} on ${row.tablename}`,
        );
      } catch (err) {
        console.error(
          `[hnsw] failed to drop ${row.indexname}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    // Best-effort — never fail engine startup over a probe.
    console.error(
      `[hnsw] zombie-index probe failed: ${(err as Error).message}`,
    );
  }
  return { dropped };
}

/**
 * Atomic-swap rebuild: build a new index with a temp name CONCURRENTLY, then
 * DROP old + RENAME temp in one transaction. If the CONCURRENTLY build fails
 * (OOM, timeout, connection drop), the old index is intact and search keeps
 * serving — the caller can retry.
 */
export async function dropAndRebuild(
  engine: Engine,
  spec: IndexSpec,
  opts: { reason: string; force?: boolean } = { reason: "manual" },
): Promise<{ rebuilt: boolean; tempName: string }> {
  if (engine.kind !== "postgres") {
    return { rebuilt: false, tempName: spec.name };
  }

  const active = await checkActiveBuild(engine, spec.name);
  if (active.active && !opts.force) {
    console.error(
      `[hnsw] dropAndRebuild ${spec.name} aborted: active build pid ${active.pid} ` +
        `(${active.application_name ?? "unknown"}). Pass force to proceed anyway.`,
    );
    return { rebuilt: false, tempName: spec.name };
  }

  // Deterministic-friendly temp suffix: the current max index generation + 1
  // would need a probe; a pid+epoch suffix is unique enough and avoids Date in
  // hot code. We read the DB clock so the name is stable per rebuild attempt.
  const clock = await engine.query<{ ms: string }>(
    `SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint::text AS ms`,
  );
  const ts = clock.rows[0]?.ms ?? "0";
  const tempName = `${spec.name}_rebuild_${ts}`;
  const where = spec.condition ? ` WHERE ${spec.condition}` : "";

  console.error(`[hnsw] rebuild ${spec.name} → ${tempName} (reason=${opts.reason})`);

  // Build the new index CONCURRENTLY. exec() = simple protocol → single
  // statement outside a transaction, which CONCURRENTLY requires.
  await engine.exec(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${tempName}" ON ${spec.table} USING ${spec.using}${where}`,
  );

  // Atomic swap.
  await engine.transaction(async (tx) => {
    await tx.exec(`DROP INDEX IF EXISTS "${spec.name}"`);
    await tx.exec(`ALTER INDEX "${tempName}" RENAME TO "${spec.name}"`);
  });

  console.error(`[hnsw] rebuild complete: ${spec.name}`);
  return { rebuilt: true, tempName };
}

export interface BuildProgress {
  elapsed_ms: number;
  size_bytes?: number;
  pid?: number;
}

/**
 * Poll pg_stat_activity to monitor a CREATE INDEX in progress, emitting a
 * progress line each interval until the build clears. Orthogonal to the build
 * itself (which runs on another connection). Time-based `sleepMs` is injected
 * so callers/tests can stub it (no Date/timer in the module core).
 */
export async function monitorBuild(
  engine: Engine,
  indexName: string,
  onProgress: (status: BuildProgress) => void,
  opts: {
    intervalMs?: number;
    maxIterations?: number;
    nowMs?: () => number;
    sleepMs?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  if (engine.kind !== "postgres") return;
  const interval = opts.intervalMs ?? 30_000;
  const maxIterations = opts.maxIterations ?? 240; // 240 * 30s = 2h cap
  const now = opts.nowMs ?? (() => Date.now());
  const sleep =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  for (let i = 0; i < maxIterations; i++) {
    const active = await checkActiveBuild(engine, indexName);
    if (!active.active) return;
    let size_bytes: number | undefined;
    try {
      const r = await engine.query<{ size: string }>(
        `SELECT pg_relation_size(c.oid)::text AS size
           FROM pg_class c WHERE c.relname = $1 LIMIT 1`,
        [indexName],
      );
      if (r.rows[0]) size_bytes = Number(r.rows[0].size);
    } catch {
      /* size probe optional */
    }
    onProgress({ elapsed_ms: now() - t0, size_bytes, pid: active.pid });
    await sleep(interval);
  }
}

/**
 * Detect whether an active build is managed-Postgres auto-maintenance (RDS)
 * rather than a memrain process — so dropAndRebuild can back off and let the
 * platform finish the rebuild. (memrain runs on RDS.)
 */
export function isExternalMaintenanceBuild(active: ActiveBuildInfo): boolean {
  if (!active.active) return false;
  const app = (active.application_name ?? "").toLowerCase();
  return (
    app.includes("rdsadmin") ||
    app.includes("autovacuum") ||
    app.includes("pg_cron") ||
    app.includes("postgres-meta")
  );
}
