/**
 * The `connector_sync` job kind and its daemon spec on both engines: the kind
 * is accepted only once registered, one job per account per interval slot
 * (re-enqueueing the same slot is a no-op), nothing is enqueued while the
 * global switch is off or the account is not runnable, the handler runs the
 * sync engine for the account the payload names, and nothing runs while the
 * daemon is disabled.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { _resetHandlersForTesting, getHandler, isKnownJobKind } from "../src/core/jobs/handlers.ts";
import { CONNECTOR_SYNC_JOB_KIND } from "../src/core/jobs/kinds.ts";
import { kindDefaultTimeoutMs } from "../src/core/jobs/kind-defaults.ts";
import { UnrecoverableJobError, type JobRow } from "../src/core/jobs/types.ts";
import { registerSource } from "../src/core/sources.ts";
import { getPage } from "../src/core/pages.ts";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";
import { getDaemon } from "../src/core/daemons/registry.ts";
import type { SyncAccount, SyncAdapter } from "../src/core/connectors/sync-engine.ts";
import {
  CONNECTOR_SYNC_DAEMON,
  connectorSyncJobId,
  enqueueConnectorSync,
  registerConnectorSync,
  type ConnectorSyncRuntime,
} from "../src/core/connectors/sync-job.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { fakeClock, replay } from "./github-recorded.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const ACCOUNT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TOKEN = ["job", "token", "value"].join("-");
const NOW = Date.parse("2026-11-14T10:07:00Z");

const adapter: SyncAdapter = {
  streams: () => ["items"],
  async page({ client }) {
    const res = await client.get("/v1/items");
    if (res.class !== "ok") return { ok: false, response: res };
    return { ok: true, items: [{ externalId: "j1", version: "1", slug: "test/job/j1", type: "note", title: "Job item", body: "Written by the job." }], checkpoint: "c1", done: true };
  },
};

const account = (over: Partial<SyncAccount> = {}): SyncAccount => ({
  id: ACCOUNT_ID, sourceId: "conn-job", provider: "test", enabled: true, status: "active", itemCapDaily: 100, spendCapUsdDaily: 1, ...over,
});

const ON = { MEMRAIN_CONNECTORS_ENABLED: "1", MEMRAIN_DAEMONS: "1" };

function runtime(acct: SyncAccount | null, env: Record<string, string> = ON): ConnectorSyncRuntime {
  const clock = fakeClock();
  return {
    env,
    loadAccount: async (id) => (acct !== null && id === acct.id ? acct : null),
    runnableAccounts: async (sourceId) => (acct !== null && acct.sourceId === sourceId ? [acct] : []),
    depsFor: () => {
      const fake = replay([{ status: 200, headers: { "content-type": "application/json" }, body: {} }]);
      return {
        adapter,
        tokenSource: async () => ({ token: async () => TOKEN, refresh: async () => TOKEN }),
        client: (_a, tokenSource) => new ConnectorClient({ origin: ORIGIN, tokenSource, fetch: fake.fetch, now: clock.now, sleep: clock.sleep }),
        accounts: { markNeedsReconnect: async () => {} },
        embedFn: async (t: string) => deterministicEmbed(t),
        env,
      };
    },
  };
}

afterEach(() => _resetHandlersForTesting());

describe("connector_sync daemon spec", () => {
  it("is a registered daemon: off by default, long-lane and paid, run per source every 15 minutes", () => {
    expect(CONNECTOR_SYNC_DAEMON).toMatchObject({
      name: "connector_sync", kind: CONNECTOR_SYNC_JOB_KIND, defaultEnabled: false, paid: true, lane: "long",
      schedule: { cron: "*/15 * * * *" }, maxRetries: 0,
    });
    expect(typeof CONNECTOR_SYNC_DAEMON.targets).toBe("function");
    expect(getDaemon("connector_sync")).toBe(CONNECTOR_SYNC_DAEMON);
    expect(kindDefaultTimeoutMs(CONNECTOR_SYNC_JOB_KIND)).toBe(30 * 60_000);
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector_sync job (${name})`, () => {
  it("is accepted only once registered, and enqueues one job per account per slot", async () => {
    const db = await open();
    try {
      expect(isKnownJobKind(CONNECTOR_SYNC_JOB_KIND)).toBe(false);
      const rt = runtime(account());
      expect(registerConnectorSync(db.storage, rt)).toBe(CONNECTOR_SYNC_DAEMON);
      expect(isKnownJobKind(CONNECTOR_SYNC_JOB_KIND)).toBe(true);

      const queue = new Queue(db.storage.engine());
      const first = await enqueueConnectorSync(queue, account(), { now: NOW, intervalMinutes: 15, env: rt.env });
      const again = await enqueueConnectorSync(queue, account(), { now: NOW + 60_000, intervalMinutes: 15, env: rt.env });
      expect(first?.outcome).toBe("created");
      expect(again?.outcome).toBe("existing");
      expect(first?.job.id).toBe(connectorSyncJobId(ACCOUNT_ID, NOW, 15));
      expect(first?.job).toMatchObject({ kind: CONNECTOR_SYNC_JOB_KIND, payload: { accountId: ACCOUNT_ID, sourceId: "conn-job" }, quietHoursSkip: true });
      const next = await enqueueConnectorSync(queue, account(), { now: NOW + 15 * 60_000, intervalMinutes: 15, env: rt.env });
      expect(next?.outcome).toBe("created");
    } finally { await db.close(); }
  });

  it("enqueues nothing while connectors are off or the account cannot run", async () => {
    const db = await open();
    try {
      const queue = new Queue(db.storage.engine());
      expect(await enqueueConnectorSync(queue, account(), { now: NOW, env: { MEMRAIN_CONNECTORS_ENABLED: "0" } })).toBeNull();
      expect(await enqueueConnectorSync(queue, account({ enabled: false }), { now: NOW, env: { MEMRAIN_CONNECTORS_ENABLED: "1" } })).toBeNull();
      expect(await enqueueConnectorSync(queue, account({ status: "needs_reconnect" }), { now: NOW, env: { MEMRAIN_CONNECTORS_ENABLED: "1" } })).toBeNull();
      const rows = await db.storage.engine().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM jobs`);
      expect(Number(rows.rows[0]!.n)).toBe(0);
    } finally { await db.close(); }
  });

  it("runs the sync engine for the payload's account and refuses a payload without one", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "conn-job", kind: "other", pathPrefix: "test/job/" });
      // connector_items references connector_accounts, so the account row exists first.
      const row = await createAccount(db.storage.engine(), { sourceId: "conn-job", provider: "test", services: ["items"], principalRef: "admin:test", accountLabel: "job@test" });
      registerConnectorSync(db.storage, runtime(account({ id: row.id })));
      const handler = getHandler(CONNECTOR_SYNC_JOB_KIND)!;
      const job = { id: "j" } as JobRow;
      // The daemon is off by default: a queued run is skipped before anything opens.
      expect(await handler({ accountId: row.id, sourceId: "conn-job" }, { job })).toEqual({ skipped: "disabled" });
      await db.storage.engine().query(`INSERT INTO daemon_controls (daemon, source_id, enabled) VALUES ('connector_sync', '*', true)`);
      const result = await handler({ accountId: row.id }, { job });
      expect(result).toMatchObject({ account_id: row.id, status: "success" });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect((await getPage(db.storage, "test/job/j1"))?.markdown_body).toContain("Written by the job.");

      await expect(handler({}, { job })).rejects.toBeInstanceOf(UnrecoverableJobError);
      await expect(handler({ accountId: "not-a-uuid" }, { job })).rejects.toBeInstanceOf(UnrecoverableJobError);
      await expect(handler({ accountId: "11111111-2222-4333-8444-5555555555ab" }, { job })).rejects.toBeInstanceOf(UnrecoverableJobError);
      await expect(handler({ accountId: row.id, sourceId: "other-source" }, { job })).rejects.toBeInstanceOf(UnrecoverableJobError);

      const bySource = await handler({ daemon: "connector_sync", sourceId: "conn-job", window: "w" }, { job });
      expect(bySource).toMatchObject({ source_id: "conn-job", accounts: [{ account_id: row.id }] });
    } finally { await db.close(); }
  });
});
