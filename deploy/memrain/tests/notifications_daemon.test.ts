/**
 * The `notifications` daemon: off by default, free, and on each run it
 * reconciles notifications, sends due webhooks (only when configured) and
 * purges old resolved rows.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { openNotice } from "../src/core/connectors/sync-store.ts";
import { getDaemon } from "../src/core/daemons/registry.ts";
import { enqueueDueDaemons } from "../src/core/daemons/scheduler.ts";
import { getHandler } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import { listNotifications } from "../src/core/notifications/store.ts";
import { NOTIFICATIONS_DAEMON, NOTIFICATIONS_JOB_KIND } from "../src/core/notifications/daemon.ts";
import { registerNotificationsDaemon, runNotifications } from "../src/core/notifications/job.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60000);

const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const WEBHOOK = {
  MEMRAIN_NOTIFY_WEBHOOK_URL: "https://hooks.example.test/memrain",
  MEMRAIN_NOTIFY_WEBHOOK_SECRET: "x".repeat(40),
};

function recorder(): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  return { urls, fetch: async (url) => { urls.push(url); return new Response(null, { status: 204 }); } };
}

async function seed(e: Engine): Promise<void> {
  await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
  await e.query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', 'o@example.test')`,
    [ACCOUNT],
  );
  await openNotice(e, ACCOUNT, "needs_reconnect", "expired");
}

describe("notifications daemon spec", () => {
  it("is registered, free, short and off until the operator enables it", () => {
    expect(getDaemon("notifications")).toBe(NOTIFICATIONS_DAEMON);
    expect(NOTIFICATIONS_DAEMON).toMatchObject({ kind: NOTIFICATIONS_JOB_KIND, paid: false, defaultEnabled: false, lane: "short" });
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`notifications daemon (${name})`, () => {
  it("reconciles without a webhook and sends nothing", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const rec = recorder();
      const r = await runNotifications(e, { env: {}, fetch: rec.fetch });
      expect(r).toMatchObject({ webhook: "off", sync: { opened: 1 }, delivery: null });
      expect(rec.urls).toEqual([]);
      expect((await listNotifications(e))[0]!.webhook_state).toBe("off");
    } finally { await db.close(); }
  });

  it("refuses a bad webhook setting without sending, and still reconciles", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const rec = recorder();
      const r = await runNotifications(e, { env: { ...WEBHOOK, MEMRAIN_NOTIFY_WEBHOOK_URL: "http://hooks.example.test/x" }, fetch: rec.fetch });
      expect(r).toMatchObject({ webhook: "refused", sync: { opened: 1 }, delivery: null });
      expect(rec.urls).toEqual([]);
    } finally { await db.close(); }
  });

  it("delivers through the scheduler gate only once the daemon is enabled", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const rec = recorder();
      const env = { MEMRAIN_DAEMONS: "1", ...WEBHOOK };
      registerNotificationsDaemon(e, { env, fetch: rec.fetch });
      const job = { id: "j" } as JobRow;
      const handler = getHandler(NOTIFICATIONS_JOB_KIND)!;
      expect(await handler({ daemon: "notifications", sourceId: "default", window: "w" }, { job })).toEqual({ skipped: "disabled" });
      const disabled = await enqueueDueDaemons(e, new Date("2026-11-14T10:00:30Z"), { env, log: () => {} });
      expect(disabled.find(d => d.daemon === "notifications")?.outcome).toBe("disabled");

      await e.query(`INSERT INTO daemon_controls (daemon, source_id, enabled) VALUES ('notifications', '*', true)`);
      const queued = await enqueueDueDaemons(e, new Date("2026-11-14T10:00:30Z"), { env, log: () => {} });
      expect(queued.find(d => d.daemon === "notifications")?.outcome).toBe("queued");
      const out = await handler({ daemon: "notifications", sourceId: "default", window: "w" }, { job });
      expect(out).toMatchObject({ webhook: "on", sync: { opened: 1 }, delivery: { delivered: 1 } });
      expect(rec.urls).toEqual([WEBHOOK.MEMRAIN_NOTIFY_WEBHOOK_URL]);
    } finally { await db.close(); }
  });
});
