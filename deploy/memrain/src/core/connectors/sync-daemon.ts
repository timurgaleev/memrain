/**
 * `connector_sync` as a scheduled daemon: every 15 minutes the scheduler
 * queues one run per source that has an enabled, active connector account,
 * and that run syncs each of the source's accounts in turn.
 *
 * Off by default (`defaultEnabled: false`), and inert until a process
 * registers the connector runtime: serve does that only with
 * MEMRAIN_CONNECTORS_ENABLED on and a usable connector key, so with either
 * missing the scheduler reports `no_handler` and queues nothing. It is paid
 * (new pages are embedded), so it also waits for a brain-wide daily cap.
 */
import type { Engine } from "../engine/interface.ts";
import type { DaemonSpec, DaemonTarget } from "../daemons/registry.ts";
import { CONNECTOR_SYNC_JOB_KIND } from "../jobs/kinds.ts";

/** The sources with at least one account a run would sync. */
export async function connectorSyncTargets(engine: Engine): Promise<DaemonTarget[]> {
  // scope: operator-only the scheduler queues one run per source; each run reads only its own source's accounts
  const r = await engine.query<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM connector_accounts WHERE enabled AND status = 'active' ORDER BY source_id`,
  );
  return r.rows.map(row => ({ sourceId: row.source_id }));
}

export const CONNECTOR_SYNC_DAEMON: DaemonSpec = {
  name: "connector_sync",
  kind: CONNECTOR_SYNC_JOB_KIND,
  schedule: { cron: "*/15 * * * *" },
  lane: "long",
  paid: true,
  defaultEnabled: false,
  targets: connectorSyncTargets,
  timeoutMs: 30 * 60_000,
  // A failed run is retried by the next window, not by spending retries now.
  maxRetries: 0,
  quietHoursSkip: true,
};
