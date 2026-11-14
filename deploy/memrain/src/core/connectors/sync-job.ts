/**
 * The `connector_sync` job: one sync run of one connector account, and the
 * daemon spec the scheduler reads to queue it.
 *
 * The shared scheduler (`core/daemons/`) is built in a parallel lane. Until it
 * lands, `DaemonSpec` below is a local stand-in with the fields that lane's
 * registry declares, and `enqueueConnectorSync` is the per-account enqueue a
 * scheduler tick calls: one job per account per interval slot, under a stable
 * id so a second tick in the same slot (or a second scheduler on the same
 * database) adds nothing. When the registry exists, CONNECTOR_SYNC_DAEMON is
 * registered there and this interface is replaced by its import.
 *
 * Nothing here registers itself: `registerConnectorSync` is called by whoever
 * wires the connector runtime (accounts, vault, adapters), so an install
 * without it refuses the kind exactly as before.
 */
import type { Storage } from "../storage.ts";
import { registerHandler } from "../jobs/handlers.ts";
import { CONNECTOR_SYNC_JOB_KIND } from "../jobs/kinds.ts";
import type { EnqueueOutcome, Queue } from "../jobs/queue.ts";
import { UnrecoverableJobError, type JobHandler, type JobRow } from "../jobs/types.ts";
import { connectorsSyncEnabled, runConnectorSync, type SyncAccount, type SyncDeps } from "./sync-engine.ts";

/** Stand-in for the scheduler lane's `DaemonSpec` (core/daemons/registry.ts). */
export interface DaemonSpec {
  name: string;
  /** The job kind a due window enqueues. */
  kind: string;
  defaultCron: string;
  paid: boolean;
  defaultCapUsdPerDay: number;
  defaultCapUsdPerRun: number;
  lane: "short" | "long";
  perTenant: boolean;
  defaultEnabled: boolean;
}

export const CONNECTOR_SYNC_DAEMON: DaemonSpec = {
  name: "connector_sync",
  kind: CONNECTOR_SYNC_JOB_KIND,
  defaultCron: "*/15 * * * *",
  // Embeddings of new pages are paid; each account's own daily cap bounds them.
  paid: true,
  defaultCapUsdPerDay: 1,
  defaultCapUsdPerRun: 1,
  lane: "long",
  perTenant: true,
  defaultEnabled: false,
};

export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const SYNC_JOB_TIMEOUT_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the job needs from the rest of the connector stack. */
export interface ConnectorSyncRuntime {
  env?: Record<string, string | undefined>;
  loadAccount(accountId: string): Promise<SyncAccount | null>;
  depsFor(account: SyncAccount): SyncDeps;
}

/** The stable id of an account's sync job in the slot containing `now`. */
export function connectorSyncJobId(accountId: string, now: number, intervalMinutes: number = DEFAULT_SYNC_INTERVAL_MINUTES): string {
  const slot = Math.floor(now / (intervalMinutes * 60_000));
  return `${CONNECTOR_SYNC_JOB_KIND}:${accountId}:${slot}`;
}

export function connectorSyncHandler(storage: Storage, runtime: ConnectorSyncRuntime): JobHandler {
  return async (payload: Record<string, unknown>, _ctx: { job: JobRow }) => {
    const accountId = payload.accountId;
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
      throw new UnrecoverableJobError("connector_sync payload needs an accountId (uuid)");
    }
    const account = await runtime.loadAccount(accountId);
    if (account === null) throw new UnrecoverableJobError(`connector account ${accountId} does not exist`);
    const result = await runConnectorSync(storage, account, runtime.depsFor(account));
    return { ...result };
  };
}

/** Accept the `connector_sync` kind in this process; returns the spec for the scheduler. */
export function registerConnectorSync(storage: Storage, runtime: ConnectorSyncRuntime): DaemonSpec {
  registerHandler(CONNECTOR_SYNC_JOB_KIND, connectorSyncHandler(storage, runtime));
  return CONNECTOR_SYNC_DAEMON;
}

export interface EnqueueSyncOptions {
  now?: number;
  intervalMinutes?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Queue the account's sync for the current slot, or do nothing (null) when
 * connectors are off or the account cannot run. The worker skips it in quiet
 * hours like any other external poll.
 */
export async function enqueueConnectorSync(
  queue: Queue,
  account: SyncAccount,
  opts: EnqueueSyncOptions = {},
): Promise<{ job: JobRow; outcome: EnqueueOutcome } | null> {
  if (!connectorsSyncEnabled(opts.env ?? process.env)) return null;
  if (!account.enabled || account.status !== "active") return null;
  const id = connectorSyncJobId(account.id, opts.now ?? Date.now(), opts.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES);
  return queue.enqueueOrRevive({
    id,
    kind: CONNECTOR_SYNC_JOB_KIND,
    payload: { accountId: account.id },
    quietHoursSkip: true,
    timeoutMs: SYNC_JOB_TIMEOUT_MS,
    // A failed run is retried by the next slot, not by spending retries now.
    maxRetries: 0,
  });
}
