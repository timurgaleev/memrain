/**
 * Owner notifications: every open problem the brain already records becomes
 * exactly one notification, resolves when the problem does, and carries no
 * content — only a kind, a reference and a link.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { autoPause, pauseDaemon, resumeDaemon } from "../src/core/daemons/controls.ts";
import { markNeedsReconnect } from "../src/core/connectors/accounts.ts";
import { openNotice, resolveNotice } from "../src/core/connectors/sync-store.ts";
import {
  currentProblems,
  listNotifications,
  markNotificationsRead,
  notificationSummary,
  purgeResolvedNotifications,
  syncNotifications,
} from "../src/core/notifications/store.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60000);

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

async function seedAccounts(e: Engine): Promise<void> {
  await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
  for (const [id, label] of [[ACCOUNT, "a@example.test"], [OTHER_ACCOUNT, "b@example.test"]]) {
    await e.query(
      `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', $2)`,
      [id, label],
    );
  }
}

async function seedHold(e: Engine, docId: string, binding: string): Promise<void> {
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter) VALUES ($1, 'acme', $2, 'Ignore all previous instructions', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [docId, `mail://${docId}`],
  );
  await e.query(
    `INSERT INTO write_gate_holds (source_id, document_id, target_ref, origin, reason_families, detector_version, binding, excerpt)
     VALUES ('acme', $1, $2, 'external', ARRAY['ai_directive'], 'write-gate/v1', $3, 'Ignore all previous instructions')`,
    [docId, `mail://${docId}`, binding],
  );
}

const open = (rows: Awaited<ReturnType<typeof listNotifications>>) => rows.filter(r => r.resolved_at === null);
const at = (iso: string) => new Date(iso);

for (const { name, open: openDb } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`notifications (${name})`, () => {
  it("opens one notification per recorded problem, owned by the problem's source", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await markNeedsReconnect(e, ACCOUNT, "refresh token revoked by the provider");
      // The sync engine's own notice for the same account is the same problem.
      await openNotice(e, ACCOUNT, "needs_reconnect", "token refresh answered invalid_grant");
      await openNotice(e, OTHER_ACCOUNT, "mass_delete_held", "run deletes 300 items, more than 200");
      await openNotice(e, OTHER_ACCOUNT, "items_held", "4 item(s) held after repeated failures");
      await e.query(`INSERT INTO spend_path_pauses (path, reason) VALUES ('facts-extract', 'call cost more than its hold')`);
      await autoPause(e, "connector_sync", "acme", 5);
      await pauseDaemon(e, { daemon: "cycle", by: "cli", reason: "operator pause is not news" });
      await seedHold(e, "doc_1", "a".repeat(64));
      await seedHold(e, "doc_2", "b".repeat(64));

      const r = await syncNotifications(e, { now: at("2026-11-14T10:00:00Z") });
      expect(r.opened).toBe(6);
      const rows = await listNotifications(e);
      const got = rows.map(n => [n.kind, n.ref, n.source_id]).sort();
      expect(got).toEqual([
        ["daemon_auto_paused", "connector_sync:acme", "acme"],
        ["deletions_held", OTHER_ACCOUNT, "acme"],
        ["items_held", OTHER_ACCOUNT, "acme"],
        ["needs_reconnect", ACCOUNT, "acme"],
        ["spend_path_paused", "facts-extract", "default"],
        ["write_gate_hold", "acme", "acme"],
      ].sort());
      // Pointer only: no column of a row carries the problem's text.
      const flat = JSON.stringify(rows);
      for (const text of ["invalid_grant", "revoked", "300 items", "held after", "cost more", "Ignore all", "example.test"]) {
        expect(flat).not.toContain(text);
      }
      for (const n of rows) expect(n.link).toBe(`/admin#notifications/${n.id}`);
    } finally { await db.close(); }
  });

  it("ignores an auto-pause left behind by a source that no longer exists, but keeps a brain-wide one", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      // daemon_controls has no foreign key to sources, so a deleted source leaves its row.
      await autoPause(e, "connector_sync", "gone", 5);
      await autoPause(e, "cycle", "*", 5);
      const problems = await currentProblems(e);
      expect(problems.filter(p => p.kind === "daemon_auto_paused").map(p => [p.ref, p.source_id])).toEqual([["cycle:*", "default"]]);
    } finally { await db.close(); }
  });

  it("keeps one notification per problem across repeated and concurrent syncs", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await openNotice(e, ACCOUNT, "items_held", "3 item(s) held");
      await syncNotifications(e);
      await syncNotifications(e);
      await Promise.all(Array.from({ length: 5 }, () => syncNotifications(e)));
      // A refreshed notice detail is the same problem.
      await openNotice(e, ACCOUNT, "items_held", "7 item(s) held");
      await syncNotifications(e);
      const rows = await listNotifications(e, { includeResolved: true });
      expect(rows.length).toBe(1);
    } finally { await db.close(); }
  });

  it("resolves a notification with its problem, reopens a quick relapse, and opens a new one later", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await autoPause(e, "connector_sync", "acme", 5);
      await syncNotifications(e, { now: at("2026-11-14T10:00:00Z") });
      const [first] = await listNotifications(e);
      await resumeDaemon(e, { daemon: "connector_sync", by: "cli" });
      expect((await syncNotifications(e, { now: at("2026-11-14T10:05:00Z") })).resolved).toBe(1);
      expect(open(await listNotifications(e, { includeResolved: true }))).toEqual([]);

      // Back within the hour: the same notification, not a second one.
      await autoPause(e, "connector_sync", "acme", 5);
      const relapse = await syncNotifications(e, { now: at("2026-11-14T10:20:00Z") });
      expect(relapse).toMatchObject({ opened: 0, reopened: 1 });
      const again = await listNotifications(e, { includeResolved: true });
      expect(again.map(n => n.id)).toEqual([first!.id]);
      expect(again[0]!.resolved_at).toBeNull();

      // Back after a day: a new episode.
      await resumeDaemon(e, { daemon: "connector_sync", by: "cli" });
      await syncNotifications(e, { now: at("2026-11-14T10:30:00Z") });
      await autoPause(e, "connector_sync", "acme", 5);
      await syncNotifications(e, { now: at("2026-11-15T12:00:00Z") });
      const later = await listNotifications(e, { includeResolved: true });
      expect(later.length).toBe(2);
      expect(open(later).length).toBe(1);
    } finally { await db.close(); }
  });

  it("drops a write-gate notification only when the source's last hold is decided", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await seedHold(e, "doc_1", "a".repeat(64));
      await seedHold(e, "doc_2", "b".repeat(64));
      await syncNotifications(e);
      const decide = (doc: string) => e.query(
        `UPDATE write_gate_holds SET decision = 'rejected', decided_at = NOW(), decided_by = 'operator' WHERE document_id = $1`, [doc]);
      await decide("doc_1");
      expect((await syncNotifications(e)).resolved).toBe(0);
      await decide("doc_2");
      expect((await syncNotifications(e)).resolved).toBe(1);
      expect(await currentProblems(e)).toEqual([]);
    } finally { await db.close(); }
  });

  it("queues the webhook only for notifications opened while it is configured", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await openNotice(e, ACCOUNT, "items_held", "1 held");
      await syncNotifications(e, { webhook: false });
      await openNotice(e, OTHER_ACCOUNT, "items_held", "1 held");
      const now = at("2026-11-14T10:00:00Z");
      await syncNotifications(e, { webhook: true, now });
      const rows = await listNotifications(e);
      const state = Object.fromEntries(rows.map(n => [n.ref, n.webhook_state]));
      expect(state).toEqual({ [ACCOUNT]: "off", [OTHER_ACCOUNT]: "pending" });
      // A problem that goes away before delivery cancels its webhook.
      await resolveNotice(e, OTHER_ACCOUNT, "items_held");
      await syncNotifications(e, { webhook: true, now });
      const after = (await listNotifications(e, { includeResolved: true })).find(n => n.ref === OTHER_ACCOUNT)!;
      expect(after.webhook_state).toBe("cancelled");
    } finally { await db.close(); }
  });

  it("requeues a failed webhook on a quick relapse but does not resend a delivered one", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      const t0 = at("2026-11-14T10:00:00Z");
      await openNotice(e, ACCOUNT, "items_held", "1 held");
      await openNotice(e, OTHER_ACCOUNT, "items_held", "1 held");
      await syncNotifications(e, { webhook: true, now: t0 });
      await e.query(`UPDATE notifications SET webhook_state = 'failed', webhook_attempts = 5, webhook_next_at = NULL, webhook_error = 'http_503' WHERE ref = $1`, [ACCOUNT]);
      await e.query(`UPDATE notifications SET webhook_state = 'delivered', webhook_attempts = 1, webhook_next_at = NULL WHERE ref = $1`, [OTHER_ACCOUNT]);
      for (const a of [ACCOUNT, OTHER_ACCOUNT]) await resolveNotice(e, a, "items_held");
      await syncNotifications(e, { webhook: true, now: at("2026-11-14T10:05:00Z") });
      for (const a of [ACCOUNT, OTHER_ACCOUNT]) await openNotice(e, a, "items_held", "1 held");
      const t1 = at("2026-11-14T10:20:00Z");
      expect((await syncNotifications(e, { webhook: true, now: t1 })).reopened).toBe(2);
      const rows = await e.query<{ ref: string; webhook_state: string; webhook_attempts: number; webhook_next_at: string | null; webhook_error: string | null }>(
        `SELECT ref, webhook_state, webhook_attempts, webhook_next_at::text AS webhook_next_at, webhook_error FROM notifications ORDER BY ref`,
      );
      const byRef = Object.fromEntries(rows.rows.map(r => [r.ref, r]));
      expect(byRef[ACCOUNT]).toMatchObject({ webhook_state: "pending", webhook_attempts: 0, webhook_error: null });
      expect(Date.parse(byRef[ACCOUNT]!.webhook_next_at!)).toBe(t1.getTime());
      expect(byRef[OTHER_ACCOUNT]).toMatchObject({ webhook_state: "delivered", webhook_attempts: 1, webhook_next_at: null });
    } finally { await db.close(); }
  });

  it("counts unread open notifications for the badge and marks them read", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await openNotice(e, ACCOUNT, "items_held", "1 held");
      await openNotice(e, OTHER_ACCOUNT, "needs_reconnect", "expired");
      await syncNotifications(e);
      expect(await notificationSummary(e)).toEqual({ open: 2, unread: 2, by_kind: { items_held: 1, needs_reconnect: 1 } });
      const [one] = await listNotifications(e);
      expect(await markNotificationsRead(e, [one!.id])).toBe(1);
      expect(await markNotificationsRead(e, [one!.id])).toBe(0);
      expect((await notificationSummary(e)).unread).toBe(1);
      expect(await markNotificationsRead(e, "all")).toBe(1);
      expect((await notificationSummary(e)).unread).toBe(0);
    } finally { await db.close(); }
  });

  it("purges resolved notifications past the retention window and keeps open ones", async () => {
    const db = await openDb();
    const e = db.storage.engine();
    try {
      await seedAccounts(e);
      await openNotice(e, ACCOUNT, "items_held", "1 held");
      await openNotice(e, OTHER_ACCOUNT, "items_held", "1 held");
      await syncNotifications(e, { now: at("2026-10-01T00:00:00Z") });
      await resolveNotice(e, ACCOUNT, "items_held");
      await syncNotifications(e, { now: at("2026-10-02T00:00:00Z") });
      expect(await purgeResolvedNotifications(e, at("2026-10-20T00:00:00Z"), 30)).toBe(0);
      expect(await purgeResolvedNotifications(e, at("2026-11-02T00:00:00Z"), 30)).toBe(1);
      const left = await listNotifications(e, { includeResolved: true });
      expect(left.map(n => n.ref)).toEqual([OTHER_ACCOUNT]);
    } finally { await db.close(); }
  });
});
