/**
 * Eval snapshots (migration 068) — durable history for the nightly retrieval-
 * quality probe.
 *
 * `replayAll` (core/eval-replay.ts) produces a ReplayReport when the captured
 * eval set is replayed against the live brain. The nightly probe
 * (deploy/systemd/memrain-eval-probe.*) calls it once/24h and appends ONE row
 * here via {@link recordEvalSnapshot}, so `doctor` can read the trend
 * ({@link latestEvalSnapshot}) without re-running retrieval.
 *
 * Append-only: nothing updates a row. A zero-scored run (empty eval set) still
 * records, so "no eval queries yet" is distinguishable from "probe never ran",
 * and a probe that threw records a `status = 'error'` row (migration 121).
 */
import type { Engine } from "./engine/interface.ts";
import type { ReplayReport } from "./eval-replay.ts";

/** How a probe run ended (migration 121). */
export type EvalSnapshotStatus = "ok" | "capped" | "error";

export interface EvalSnapshotRow {
  id: number;
  ran_at: string;
  total_queries: number;
  scored: number;
  mean_rr: number;
  hit_rate: number;
  detail: Record<string, unknown>;
  status: EvalSnapshotStatus;
}

/**
 * Append one snapshot row from a replay report. The scalar columns
 * (mean_rr/hit_rate/scored) are the trend axes; `detail` keeps the baseline +
 * stability blocks as JSON so a reader gets the full picture without a schema
 * change per metric. `status` is `capped` when a limit left part of the eval
 * set unreplayed. Returns the new row id.
 */
export async function recordEvalSnapshot(
  engine: Engine,
  report: ReplayReport,
  status: Exclude<EvalSnapshotStatus, "error"> = "ok",
): Promise<{ id: number }> {
  const detail: Record<string, unknown> = {
    ok: report.ok,
    mean_rr_ci95: report.meanRRCi95,
    hit_rate_ci95: report.hitRateCi95,
    replayed_ids_sha256: report.replayedIdsSha256,
    unscored: report.unscored,
  };
  if (report.baseline) detail.baseline = report.baseline;
  if (report.stability) detail.stability = report.stability;
  const r = await engine.query<{ id: number }>(
    `INSERT INTO eval_snapshots
       (ran_at, total_queries, scored, mean_rr, hit_rate, detail, status)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6::text::jsonb, $7)
     RETURNING id`,
    [
      report.ranAt,
      report.totalQueries,
      report.scored,
      report.meanRR,
      report.hitRate,
      JSON.stringify(detail),
      status,
    ],
  );
  return { id: r.rows[0]!.id };
}

/**
 * Append the row for a probe that threw. The scalar columns stay zero and
 * measure nothing; readers tell this row apart by `status = 'error'`.
 */
export async function recordFailedEvalSnapshot(
  engine: Engine,
  ranAt: string,
  error: string,
): Promise<{ id: number }> {
  const r = await engine.query<{ id: number }>(
    `INSERT INTO eval_snapshots (ran_at, detail, status)
     VALUES ($1::timestamptz, $2::text::jsonb, 'error')
     RETURNING id`,
    [ranAt, JSON.stringify({ ok: false, error })],
  );
  return { id: r.rows[0]!.id };
}

/**
 * Most-recent snapshot, or null when the probe has never run (or the table
 * predates migration 068). Degrades to null on an undefined-table error so a
 * doctor read on an old brain doesn't crash.
 */
export async function latestEvalSnapshot(
  engine: Engine,
): Promise<EvalSnapshotRow | null> {
  const select = (statusCol: string) =>
    engine.query<EvalSnapshotRow>(
      `SELECT id, ran_at::text AS ran_at, total_queries, scored,
              mean_rr, hit_rate, detail, ${statusCol} AS status
         FROM eval_snapshots
        ORDER BY ran_at DESC, id DESC
        LIMIT 1`,
    );
  try {
    try {
      return (await select("status")).rows[0] ?? null;
    } catch (e) {
      // Pre-121 table: every row it holds was a completed run.
      const msg = (e as { message?: string } | null)?.message ?? "";
      if (!/column .*status.* does not exist/i.test(msg)) throw e;
      return (await select("'ok'::text")).rows[0] ?? null;
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    const msg = (e as { message?: string } | null)?.message ?? "";
    if (code === "42P01" || /relation .*eval_snapshots.* does not exist/i.test(msg)) {
      return null;
    }
    throw e;
  }
}
