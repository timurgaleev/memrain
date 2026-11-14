/**
 * The `connector_sync` job: sync runs of connector accounts, queued by the
 * daemon scheduler (sync-daemon.ts) or for one account by
 * `enqueueConnectorSync`.
 *
 * A scheduled run names a source and syncs each of its enabled, active
 * accounts in turn; a single-account run names the account (and its source).
 * A single-account payload must also name the account's source: either way
 * the handler goes through the scheduler's daemon gate, so a
 * paused or disabled `connector_sync` (globally or for that source) and the
 * MEMRAIN_DAEMONS kill switch stop it before any credential is opened.
 *
 * Nothing here registers itself: `registerConnectorSync` is called by whoever
 * wires the connector runtime (runtime.ts), so an install without it refuses
 * the kind exactly as before.
 */
import type { Storage } from "../storage.ts";
import { registerDaemonHandler } from "../daemons/scheduler.ts";
import type { DaemonSpec } from "../daemons/registry.ts";
import { CONNECTOR_SYNC_JOB_KIND } from "../jobs/kinds.ts";
import type { EnqueueOutcome, Queue } from "../jobs/queue.ts";
import { UnrecoverableJobError, type JobHandler, type JobRow } from "../jobs/types.ts";
import { runConnectorSync, type SyncAccount, type SyncDeps } from "./sync-engine.ts";
import { CONNECTOR_SYNC_DAEMON } from "./sync-daemon.ts";
import { connectorsSwitchOn } from "./vault.ts";

export { CONNECTOR_SYNC_DAEMON };

export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const SYNC_JOB_TIMEOUT_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the job needs from the rest of the connector stack. */
export interface ConnectorSyncRuntime {
  env?: Record<string, string | undefined>;
  loadAccount(accountId: string): Promise<SyncAccount | null>;
  /** The source's accounts a scheduled run syncs: enabled and active. */
  runnableAccounts(sourceId: string): Promise<SyncAccount[]>;
  depsFor(account: SyncAccount): SyncDeps;
}

/** The stable id of an account's sync job in the slot containing `now`. */
export function connectorSyncJobId(accountId: string, now: number, intervalMinutes: number = DEFAULT_SYNC_INTERVAL_MINUTES): string {
  const slot = Math.floor(now / (intervalMinutes * 60_000));
  return `${CONNECTOR_SYNC_JOB_KIND}:${accountId}:${slot}`;
}

export function connectorSyncHandler(storage: Storage, runtime: ConnectorSyncRuntime): JobHandler {
  return async (payload: Record<string, unknown>, _ctx: { job: JobRow }) => {
    const { accountId, sourceId } = payload;
    if (accountId !== undefined) {
      if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
        throw new UnrecoverableJobError("connector_sync payload needs an accountId (uuid)");
      }
      const account = await runtime.loadAccount(accountId);
      if (account === null) throw new UnrecoverableJobError(`connector account ${accountId} does not exist`);
      // The daemon gate checked the payload source's pause; a run without the
      // account's own source would slip past that source's pause.
      if (sourceId !== account.sourceId) {
        throw new UnrecoverableJobError(`connector_sync payload must name the source of account ${accountId}`);
      }
      return { ...await runConnectorSync(storage, account, runtime.depsFor(account)) };
    }
    if (typeof sourceId !== "string" || sourceId === "") {
      throw new UnrecoverableJobError("connector_sync payload needs an accountId (uuid) or a sourceId");
    }
    const accounts = [];
    for (const account of await runtime.runnableAccounts(sourceId)) {
      accounts.push(await runConnectorSync(storage, account, runtime.depsFor(account)));
    }
    return { source_id: sourceId, accounts };
  };
}

/** Accept the `connector_sync` kind in this process, behind the daemon gate; returns its spec. */
export function registerConnectorSync(storage: Storage, runtime: ConnectorSyncRuntime): DaemonSpec {
  registerDaemonHandler(storage.engine(), CONNECTOR_SYNC_DAEMON, connectorSyncHandler(storage, runtime), {
    ...(runtime.env ? { env: runtime.env } : {}),
  });
  return CONNECTOR_SYNC_DAEMON;
}

export interface EnqueueSyncOptions {
  now?: number;
  intervalMinutes?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Queue one account's sync for the current slot, or do nothing (null) when
 * connectors are off or the account cannot run. The worker skips it in quiet
 * hours like any other external poll.
 */
export async function enqueueConnectorSync(
  queue: Queue,
  account: SyncAccount,
  opts: EnqueueSyncOptions = {},
): Promise<{ job: JobRow; outcome: EnqueueOutcome } | null> {
  if (!connectorsSwitchOn(opts.env ?? process.env)) return null;
  if (!account.enabled || account.status !== "active") return null;
  const id = connectorSyncJobId(account.id, opts.now ?? Date.now(), opts.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES);
  return queue.enqueueOrRevive({
    id,
    kind: CONNECTOR_SYNC_JOB_KIND,
    payload: { accountId: account.id, sourceId: account.sourceId },
    quietHoursSkip: true,
    timeoutMs: SYNC_JOB_TIMEOUT_MS,
    // A failed run is retried by the next slot, not by spending retries now.
    maxRetries: 0,
  });
}
