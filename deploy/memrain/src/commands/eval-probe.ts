/**
 * `memrain eval-probe` — nightly retrieval-quality snapshot.
 *
 * Replays the captured eval set (eval_queries, via `replayAll`) against the
 * live brain and appends ONE row to `eval_snapshots` (migration 068) so the
 * quality trend is queryable by `doctor` without re-running retrieval.
 *
 * Intended to run once/24h from the systemd timer
 * (deploy/systemd/memrain-eval-probe.*). Runs against the live brain, so it is
 * Bedrock-billable for the hybrid arm — keep the eval set small. NEVER promotes
 * the baseline (read-only against the eval set apart from the snapshot append)
 * and NEVER exits non-zero on a quality drop: this is a passive probe, not a CI
 * gate (that is `eval-replay run`). An empty eval set records a zero-scored row
 * and exits 0. Every run leaves a row: one a limit cut short is `capped`, one
 * that threw is `error` (and the probe still exits non-zero).
 *
 * The replayed subset is the eval set in id order, so a cap selects the same
 * queries night after night; `detail.replayed_ids_sha256` names the set.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { countQueries, replayAll, type ReplayReport } from "../core/eval-replay.ts";
import {
  recordEvalSnapshot,
  recordFailedEvalSnapshot,
  type EvalSnapshotStatus,
} from "../core/eval-snapshot.ts";

export interface EvalProbeOptions {
  /** Cap on queries replayed. Forwarded to replayAll (default 100 there). */
  limit?: number;
  /**
   * Per-run cost ceiling in USD. Converted to an effective query cap via a
   * conservative per-query cost estimate (the probe embeds each query and runs
   * the hybrid arm), then applied as `min(limit, floor(maxUsd / est))`. A cheap,
   * deterministic guard so a large eval set can't run an unbounded paid probe.
   */
  maxUsd?: number;
}

/** Conservative estimate of one probe query's Bedrock cost (a Titan query embed
 *  plus the hybrid arm). Deliberately high so the USD cap errs toward stopping
 *  early rather than overspending. */
export const PER_QUERY_USD_ESTIMATE = 0.001;

/**
 * Effective query cap from an optional explicit limit + an optional USD ceiling.
 * The USD cap converts to a query count via {@link PER_QUERY_USD_ESTIMATE}; when
 * both are set the tighter of the two wins. Returns undefined when neither is
 * set (replayAll applies its own default).
 */
export function effectiveProbeLimit(
  limit: number | undefined,
  maxUsd: number | undefined,
): number | undefined {
  if (maxUsd === undefined) return limit;
  const budgetCap = Math.max(1, Math.floor(maxUsd / PER_QUERY_USD_ESTIMATE));
  return limit !== undefined ? Math.min(limit, budgetCap) : budgetCap;
}

/** The probe's stdout JSON: the trend axes with their bootstrap intervals. */
export function probeSummary(
  report: ReplayReport,
  snapshotId: number,
  status: EvalSnapshotStatus = "ok",
): Record<string, unknown> {
  return {
    ok: true,
    snapshot_id: snapshotId,
    status,
    ran_at: report.ranAt,
    total_queries: report.totalQueries,
    scored: report.scored,
    mean_rr: report.meanRR,
    mean_rr_ci95: report.meanRRCi95,
    hit_rate: report.hitRate,
    hit_rate_ci95: report.hitRateCi95,
    replayed_ids_sha256: report.replayedIdsSha256,
    unscored: report.unscored,
  };
}

/**
 * Replay once and record exactly one snapshot, whatever happens: `ok` for a
 * run over the whole eval set, `capped` when the limit left queries out,
 * `error` (then rethrow) when the replay threw.
 */
export async function probeOnce(
  storage: Storage,
  opts: EvalProbeOptions = {},
  replay: typeof replayAll = replayAll,
): Promise<{ id: number; status: EvalSnapshotStatus; report: ReplayReport }> {
  const engine = storage.engine();
  const ranAt = new Date().toISOString();
  const replayOpts: Parameters<typeof replayAll>[1] = {};
  const effLimit = effectiveProbeLimit(opts.limit, opts.maxUsd);
  if (effLimit !== undefined) replayOpts.limit = effLimit;
  // Counted before the replay, so a query captured mid-run cannot mark a
  // complete run as capped.
  const available = await countQueries(engine);
  let report: ReplayReport;
  try {
    report = await replay(storage, replayOpts);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await recordFailedEvalSnapshot(engine, ranAt, message);
    } catch (writeErr) {
      console.error(
        `eval-probe: could not record the failed run: ${writeErr instanceof Error ? writeErr.message : writeErr}`,
      );
    }
    throw e;
  }
  const status: EvalSnapshotStatus = available > report.totalQueries ? "capped" : "ok";
  const { id } = await recordEvalSnapshot(engine, report, status);
  return { id, status, report };
}

export async function runEvalProbe(opts: EvalProbeOptions = {}): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const { id, status, report } = await probeOnce(storage, opts);
    console.log(JSON.stringify(probeSummary(report, id, status), null, 2));
  });
}
