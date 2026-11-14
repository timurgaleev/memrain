/** The `notifications` doctor check: open problems by kind and the webhook's health, read-only. */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { openNotice } from "../src/core/connectors/sync-store.ts";
import { syncNotifications } from "../src/core/notifications/store.ts";
import { checkNotifications } from "../src/core/notifications/doctor.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60000);

const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const SECRET = "y".repeat(40);
const WEBHOOK = { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://hooks.example.test/x", MEMRAIN_NOTIFY_WEBHOOK_SECRET: SECRET };
const count = async (e: Engine) => (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications`)).rows[0]!.n;

async function seed(e: Engine): Promise<void> {
  await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
  await e.query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', 'o@example.test')`,
    [ACCOUNT],
  );
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`notifications doctor (${name})`, () => {
  it("is ok with nothing open and no webhook", async () => {
    const db = await open();
    try {
      const r = await checkNotifications(db.storage.engine(), { env: {} });
      expect(r).toMatchObject({ ok: true, status: "ok" });
      expect(r.detail).toContain("webhook off");
    } finally { await db.close(); }
  });

  it("warns on open problems by kind without writing anything", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      await openNotice(e, ACCOUNT, "items_held", "2 held: subject 'Quarterly numbers'");
      const r = await checkNotifications(e, { env: {} });
      expect(r).toMatchObject({ ok: true, status: "warn" });
      expect(r.detail).toContain("1 open (items_held 1)");
      expect(r.detail).not.toContain("Quarterly");
      expect(await count(e)).toBe(0);
    } finally { await db.close(); }
  });

  it("warns on a refused webhook setting and never echoes the secret", async () => {
    const db = await open();
    try {
      const r = await checkNotifications(db.storage.engine(), { env: { ...WEBHOOK, MEMRAIN_NOTIFY_WEBHOOK_URL: "http://hooks.example.test/x" } });
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("https");
      expect(r.detail).not.toContain(SECRET);
    } finally { await db.close(); }
  });

  it("warns on failed deliveries and on pending ones nobody is sending", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      await openNotice(e, ACCOUNT, "items_held", "1 held");
      const then = new Date("2026-11-14T08:00:00Z");
      await syncNotifications(e, { webhook: true, now: then });
      const stale = await checkNotifications(e, { env: WEBHOOK, now: new Date("2026-11-14T10:00:00Z") });
      expect(stale.status).toBe("warn");
      expect(stale.detail).toContain("1 webhook delivery waiting");
      expect(stale.detail).toContain("memrain daemons enable notifications");
      await e.query(`UPDATE notifications SET webhook_state = 'failed', webhook_error = 'http_500', webhook_next_at = NULL`);
      const failed = await checkNotifications(e, { env: WEBHOOK, now: new Date("2026-11-14T10:00:00Z") });
      expect(failed.detail).toContain("1 webhook delivery failed (last error http_500)");
    } finally { await db.close(); }
  });
});
