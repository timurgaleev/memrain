/**
 * `memrain eval bench` — score the synthetic search bench (src/eval/bench/).
 *
 *   eval bench [--json] [--k12] [--write-snapshot]
 *
 * Builds a throwaway PGLite brain from the shipped corpus, runs every bench
 * query through the real hybrid search with the deterministic embedder, and
 * prints metrics overall and per tag, the decoy line and the model spend of
 * the run (always zero; anything else fails it). It never opens the
 * operator's brain and needs no config.
 *
 *   --k12             also run without the mail noise and report whether the
 *                     mailbox displaced any page people wrote (K12)
 *   --write-snapshot  rewrite src/eval/bench/snapshot.json from this run; a
 *                     ranking change that is meant commits the new snapshot
 *   --json            include the ranked pages and per-query scores
 *
 * The report says whether this run matches the pinned snapshot. Exit 0 when
 * every decoy was rejected, nothing was spent, no query threw and (with
 * --k12) K12 held; 1 otherwise; 2 when a setting would make indexing paid.
 */
import { writeFileSync } from "node:fs";
import {
  BenchUnsafeConfig,
  benchSnapshot,
  benchSnapshotPath,
  k12Check,
  readBenchSnapshot,
  runBench,
  snapshotDiff,
  type BenchSnapshot,
} from "../eval/bench/harness.ts";

export interface EvalBenchOptions {
  json?: boolean;
  k12?: boolean;
  writeSnapshot?: boolean;
  /** Test seam: where --write-snapshot writes. */
  snapshotPath?: string;
}

function snapshotOrNull(path: string): BenchSnapshot | null {
  try {
    return readBenchSnapshot(path);
  } catch {
    return null;
  }
}

export async function runEvalBench(opts: EvalBenchOptions = {}): Promise<number> {
  const path = opts.snapshotPath ?? benchSnapshotPath();
  try {
    const report = await runBench();
    const k12 = opts.k12 ? k12Check(report, await runBench({ includeMail: false })) : null;
    const pinned = snapshotOrNull(path);
    const changed = pinned ? snapshotDiff(pinned, report) : null;
    if (opts.writeSnapshot && report.ok) writeFileSync(path, `${JSON.stringify(benchSnapshot(report), null, 2)}\n`);
    const ok = report.ok && (k12 === null || k12.pass);
    const { ranked: _ranked, per_query: _perQuery, ...summary } = report;
    console.log(JSON.stringify({
      ...(opts.json ? report : summary),
      ok,
      decoys_line: `DECOYS: ${report.decoys.passed.length}/${report.decoys.total} passed`,
      snapshot: pinned === null
        ? { pinned: false }
        : { pinned: true, matches: changed!.length === 0 && pinned.qrels_sha256 === report.qrels_sha256, changed: changed! },
      ...(opts.writeSnapshot ? { snapshot_written: report.ok ? path : null } : {}),
      ...(k12 ? { k12 } : {}),
    }, null, 2));
    return ok ? 0 : 1;
  } catch (e) {
    console.error(`memrain eval bench: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof BenchUnsafeConfig ? 2 : 1;
  }
}
