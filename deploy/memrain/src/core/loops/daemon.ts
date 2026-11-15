/**
 * `loops_sweep` as a scheduled daemon: every 30 minutes, for each source that
 * has connector reply states, re-judge the recent threads and open or close
 * loops. It makes no model call and no network call, so it spends nothing.
 *
 * Off by default (`defaultEnabled: false`, and the scheduler itself needs
 * MEMRAIN_DAEMONS=1). Thread states are recorded by the connector sync either
 * way, so turning the daemon on later still sees the last 14 days.
 */
import type { Engine } from "../engine/interface.ts";
import type { DaemonSpec, DaemonTarget } from "../daemons/registry.ts";

export const LOOPS_SWEEP_JOB_KIND = "loops_sweep";

/** The sources with at least one recorded thread state. */
export async function loopsSweepTargets(engine: Engine): Promise<DaemonTarget[]> {
  // scope: operator-only the scheduler queues one run per source; each run reads only its own source's threads
  const r = await engine.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM loop_threads ORDER BY source_id`);
  return r.rows.map(row => ({ sourceId: row.source_id }));
}

export const LOOPS_SWEEP_DAEMON: DaemonSpec = {
  name: "loops_sweep",
  kind: LOOPS_SWEEP_JOB_KIND,
  schedule: { cron: "*/30 * * * *" },
  lane: "short",
  paid: false,
  defaultEnabled: false,
  targets: loopsSweepTargets,
  timeoutMs: 5 * 60_000,
  // A failed run is redone by the next window.
  maxRetries: 0,
};
