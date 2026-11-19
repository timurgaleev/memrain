/**
 * Planner statistics for the hot tables.
 *
 * Postgres keeps them fresh through autovacuum; the doctor only reads its
 * counters. PGLite has no autovacuum, so a self-host brain plans against
 * tables that were never analyzed. With MEMRAIN_PGLITE_AUTO_ANALYZE=1 a hot
 * table is analyzed after a cycle and after an import once its live row count
 * has moved by more than max(500, 10%) from the planner's estimate
 * (`pg_class.reltuples`, -1 before the first analyze). PGLite does not flush
 * per-table modification counters, so the row-count drift stands in for them;
 * updates that leave the count alone are not seen.
 */
import { couldNotCheck } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import type { TenancyCheck } from "./doctor-tenancy.ts";

const FLAG = "MEMRAIN_PGLITE_AUTO_ANALYZE";
export const HOT_TABLES = ["pages", "chunks", "embeddings", "entity_facts", "links"] as const;

export function autoAnalyzeEnabled(): boolean {
  const v = process.env[FLAG];
  return v === "1" || v === "true";
}

/** Rows a table may drift by before its statistics count as stale. */
export function analyzeThreshold(estimate: number): number {
  return Math.max(500, Math.ceil(Math.max(estimate, 0) * 0.1));
}

export interface TableStat {
  table: string;
  /** Live rows now. */
  live: number;
  /** Rows changed since the last analyze (or, before any, every live row). */
  modified: number;
}

function stale(stat: TableStat): boolean {
  return stat.modified >= analyzeThreshold(stat.live);
}

/** PGLite: live count against the planner's estimate. */
async function pgliteStats(engine: Engine): Promise<TableStat[]> {
  const out: TableStat[] = [];
  for (const table of HOT_TABLES) {
    const est = await engine.query<{ reltuples: number }>(
      `SELECT reltuples::float8 AS reltuples FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
      [table],
    );
    if (!est.rows[0]) continue;
    // scope: operator-only planner statistics count every row of a hot table
    const cnt = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    const live = cnt.rows[0]?.n ?? 0;
    const estimate = Number(est.rows[0].reltuples);
    out.push({ table, live, modified: estimate < 0 ? live : Math.abs(live - estimate) });
  }
  return out;
}

/** Postgres: the cumulative statistics autovacuum itself reads. */
async function postgresStats(engine: Engine): Promise<TableStat[]> {
  const r = await engine.query<{ relname: string; live: number; modified: number }>(
    `SELECT relname, n_live_tup::float8 AS live, n_mod_since_analyze::float8 AS modified
       FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = ANY($1::text[])`,
    [[...HOT_TABLES]],
  );
  return r.rows.map(x => ({ table: x.relname, live: Number(x.live), modified: Number(x.modified) }));
}

export interface AnalyzeResult {
  skipped?: "off" | "postgres";
  analyzed: string[];
}

/**
 * Analyze the PGLite hot tables whose statistics are stale. A no-op on
 * Postgres and while the flag is off. The table names come from HOT_TABLES,
 * never from input.
 */
export async function maybeAnalyzeHotTables(engine: Engine): Promise<AnalyzeResult> {
  if (engine.kind !== "pglite") return { skipped: "postgres", analyzed: [] };
  if (!autoAnalyzeEnabled()) return { skipped: "off", analyzed: [] };
  const analyzed: string[] = [];
  for (const stat of await pgliteStats(engine)) {
    if (!stale(stat)) continue;
    await engine.exec(`ANALYZE ${stat.table}`);
    analyzed.push(stat.table);
  }
  return { analyzed };
}

export function plannerStatsVerdict(stats: readonly TableStat[]): { status: "ok" | "warn"; detail: string } {
  const behind = stats.filter(stale);
  if (behind.length === 0) return { status: "ok", detail: "hot-table planner statistics are current" };
  const list = behind.map(s => `${s.table} (${Math.round(s.modified)} of ${Math.round(s.live)} rows changed)`).join(", ");
  return {
    status: "warn",
    detail: `planner statistics are stale for ${list}; run ANALYZE ${behind.map(s => s.table).join(", ")}`,
  };
}

/** Doctor `planner-stats`: warn when a hot table's statistics lag its contents. */
export async function checkPlannerStats(engine: Engine): Promise<TenancyCheck> {
  const name = "planner-stats";
  try {
    const pglite = engine.kind === "pglite";
    const verdict = plannerStatsVerdict(pglite ? await pgliteStats(engine) : await postgresStats(engine));
    if (verdict.status === "ok") return { name, ok: true, status: "ok", detail: verdict.detail };
    const hint = pglite
      ? ` (PGLite has no autovacuum; set ${FLAG}=1 to analyze after each cycle and import)`
      : " (or check that autovacuum is running)";
    return { name, ok: true, status: "warn", detail: verdict.detail + hint };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * maybeAnalyzeHotTables after a write that has already finished (a cycle, an
 * import). Statistics are maintenance, not part of the write: a failure comes
 * back as `analyze_error` instead of turning the finished write into an error.
 * Undefined when nothing was analyzed, so a caller's report is unchanged.
 */
export async function analyzeQuietly(engine: Engine): Promise<{ analyzed: string[] } | { analyze_error: string } | undefined> {
  try {
    const r = await maybeAnalyzeHotTables(engine);
    return r.analyzed.length > 0 ? { analyzed: r.analyzed } : undefined;
  } catch (e) {
    return { analyze_error: e instanceof Error ? e.message : String(e) };
  }
}
