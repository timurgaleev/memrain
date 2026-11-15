/**
 * The admin routes behind the Connections page: switching an account's sync,
 * disconnecting it only after its name is typed, previewing and deleting
 * everything it wrote only once it is disconnected, the deletions and items a
 * sync run held for the owner, and removing a bring-your-own OAuth client.
 * The list never carries a token or a client secret. Both engines; the
 * provider is played by a recorded fetch.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fakeProvider, TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN, testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { createAccount, getAccount, storeCredential, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import { getOAuthClient, setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { accountRef } from "../src/core/connectors/model.ts";
import { MASS_DELETE, openNotice } from "../src/core/connectors/sync-store.ts";
import { recordAccountRun } from "../src/core/connectors/account-status.ts";
import { handleAdminConnectors, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import type { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const ORIGIN = "https://brain.example.test";
const OWNER = "owner@example.test";
const kek = kekFromBytes(randomBytes(32));
const ENV = { MEMRAIN_TEST_OAUTH_CLIENT_ID: "env-client", MEMRAIN_TEST_OAUTH_CLIENT_SECRET: "env-secret" };

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(testProvider("test"));
  return r;
}

function deps(storage: Storage, extra: Partial<AdminConnectorDeps> = {}): AdminConnectorDeps {
  return {
    storage,
    publicUrl: ORIGIN,
    adminSessionId: () => "sess-1",
    status: () => ({ enabled: true, kekId: kek.id, reason: null }),
    kek: () => kek,
    providers: registry(),
    fetch: fakeProvider().fetch,
    env: ENV,
    ...extra,
  };
}

const post = (path: string, body: unknown = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`${ORIGIN}${path}`);

async function call(req: Request, d: AdminConnectorDeps): Promise<Response> {
  const res = await handleAdminConnectors(req, new URL(req.url), d);
  if (!res) throw new Error(`route not handled: ${req.method} ${req.url}`);
  return res;
}

async function connected(engine: Engine): Promise<ConnectorAccount> {
  await registerSource(engine, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
  const account = await createAccount(engine, {
    sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: OWNER,
  });
  await storeCredential(engine, kek, account, { access_token: TEST_ACCESS_TOKEN, refresh_token: TEST_REFRESH_TOKEN }, { scopes: ["mail.read"], expiresAt: null });
  return account;
}

/** A page the account's connector wrote, as the sync engine would. */
async function connectorPage(storage: Storage, slug: string): Promise<void> {
  await putPage(storage, {
    slug, type: "email", allowAdHocType: true, title: slug, markdown_body: `Body of ${slug}.`,
    compiled_truth: { origin: "connector", account: accountRef(OWNER), kind: "mail" },
    written_by: "connector-test", source_id: "inbox", outsideText: true,
  });
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin connection routes (${name})`, () => {
  it("list each account's held items, held deletions, open notices and credential scopes, with no secret", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await setOAuthClient(e, kek, "test", "byo-id", "byo-secret-value");
      await e.query(
        `INSERT INTO connector_items (account_id, external_id, page_slug, fail_count, held_reason) VALUES
           ($1, 'a', 'mail/a', 3, 'item_error'), ($1, 'b', 'mail/b', 0, $2), ($1, 'c', 'mail/c', 0, $2)`,
        [account.id, MASS_DELETE],
      );
      await openNotice(e, account.id, "mass_delete_held", "run deletes 2 of 3 items");

      const res = await call(get("/admin/api/connectors"), deps(db.storage));
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of [TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN, "byo-secret-value", "env-secret"]) expect(text).not.toContain(secret);
      const body = JSON.parse(text) as {
        providers: Array<{ id: string; services: string[]; service_kinds: Record<string, string[]>; auth: string; callback_uri: string | null }>;
        sources: Array<{ id: string; kind: string }>;
        accounts: Array<ConnectorAccount & { held_items: number; held_deletes: number; notices: Array<{ kind: string; detail: string }>; credential: { scopes: string[] } | null }>;
      };
      expect(body.providers).toEqual([{
        id: "test", services: ["mail", "calendar"], service_kinds: { mail: ["mailbox"], calendar: ["calendar"] }, auth: "oauth",
        callback_uri: `${ORIGIN}/admin/connectors/callback/test`,
      }]);
      expect(body.sources).toContainEqual({ id: "inbox", kind: "mailbox" });
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]).toMatchObject({
        id: account.id, account_label: OWNER, held_items: 1, held_deletes: 2,
        notices: [{ kind: "mass_delete_held", detail: "run deletes 2 of 3 items" }],
        credential: { scopes: ["mail.read"] },
      });
    } finally { await db.close(); }
  });

  it("list each account's last run, whether it waits on a reconnect, and when a Google Testing-mode grant ends", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      const google = await createAccount(e, { sourceId: "cal", provider: "google", services: ["calendar"], principalRef: "admin:operator", accountLabel: OWNER });
      await storeCredential(e, kek, google, { access_token: TEST_ACCESS_TOKEN, refresh_token: TEST_REFRESH_TOKEN }, { scopes: ["calendar.readonly"], expiresAt: null });
      await recordAccountRun(e, google.id, {
        account_id: google.id, source_id: "cal", status: "partial", stop_reason: "fetch_failed", streams: [], error_class: "rate_limited",
        http_status: 429, error: "calendar list failed: rate_limited",
        counts: { items: 4, pages_written: 1, pages_unchanged: 3, duplicates: 0, items_failed: 0, items_held: 0, items_skipped_held: 0,
          deletions_seen: 0, deletions_applied: 0, deletions_held: 0, retention_deleted: 0, mirror_failures: 0 },
      });

      const body = await (await call(get("/admin/api/connectors"), deps(db.storage))).json() as {
        accounts: Array<Record<string, unknown> & { credential: { granted_at: string } | null; grant_expiry: { expires_at: string } | null }>;
      };
      const row = body.accounts[0]!;
      expect(row).toMatchObject({
        id: google.id, needs_reconnect: false,
        last_run: { status: "partial", stop_reason: "fetch_failed", http_status: 429, items: 4 },
        grant_expiry: { state: "upcoming", days: 7 },
      });
      expect(Date.parse(row.grant_expiry!.expires_at) - Date.parse(row.credential!.granted_at)).toBe(7 * 86_400_000);
    } finally { await db.close(); }
  });

  it("name the callback address to register in a bring-your-own app, and none without a usable public URL", async () => {
    const db = await open();
    try {
      type Listed = { providers: Array<{ id: string; callback_uri: string | null }> };
      const listed = async (d: AdminConnectorDeps) => ((await (await call(get("/admin/api/connectors"), d)).json()) as Listed).providers[0]!.callback_uri;
      expect(await listed(deps(db.storage))).toBe(`${ORIGIN}/admin/connectors/callback/test`);
      expect(await listed(deps(db.storage, { publicUrl: undefined }))).toBeNull();
      expect(await listed(deps(db.storage, { publicUrl: "http://brain.example.test" }))).toBeNull();
    } finally { await db.close(); }
  });

  it("switch an account's sync on and off, and say when the account is unknown", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      const on = await call(post(`/admin/api/connectors/accounts/${account.id}/enable`), deps(db.storage));
      expect(await on.json()).toEqual({ ok: true, enabled: true });
      expect((await getAccount(e, account.id))!.enabled).toBe(true);
      const off = await call(post(`/admin/api/connectors/accounts/${account.id}/disable`), deps(db.storage));
      expect(await off.json()).toEqual({ ok: true, enabled: false });
      expect((await getAccount(e, account.id))!.enabled).toBe(false);

      const missing = await call(post("/admin/api/connectors/accounts/00000000-0000-4000-8000-00000000000a/enable"), deps(db.storage));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "account_not_found" });
      const malformed = await call(post("/admin/api/connectors/accounts/not-a-uuid/enable"), deps(db.storage));
      expect(malformed.status).toBe(400);
    } finally { await db.close(); }
  });

  it("refuse a disconnect whose typed name does not match, and change nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      const fake = fakeProvider();
      for (const confirm of [undefined, "", "someone@example.test", ` ${OWNER.toUpperCase()} `]) {
        const res = await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: confirm }), deps(db.storage, { fetch: fake.fetch }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "confirm_mismatch" });
      }
      expect(fake.calls).toEqual([]);
      expect((await getAccount(e, account.id))!.status).toBe("active");
    } finally { await db.close(); }
  });

  it("disconnect keeps the pages, revokes the token upstream and drops the credential", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await connectorPage(db.storage, "mail/2026-11/kept");
      const fake = fakeProvider();
      const res = await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: ` ${OWNER} ` }), deps(db.storage, { fetch: fake.fetch }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: true, credential_kept: false });
      expect(fake.calls.map((c) => c.url)).toEqual(["https://auth.provider.test/revoke"]);
      expect(await getAccount(e, account.id)).toMatchObject({ status: "revoked", enabled: false });
      expect((await e.query("SELECT 1 FROM connector_credentials WHERE account_id = $1", [account.id])).rows).toHaveLength(0);
      expect((await e.query("SELECT 1 FROM pages WHERE slug = 'mail/2026-11/kept'")).rows).toHaveLength(1);
    } finally { await db.close(); }
  });

  it("needs the connector key to disconnect, since the revoke opens the credential", async () => {
    const db = await open();
    try {
      const account = await connected(db.storage.engine());
      const off = deps(db.storage, { status: () => ({ enabled: false, kekId: null, reason: "no connector key" }), kek: () => null });
      const res = await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), off);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "connectors_disabled", reason: "no connector key" });
      expect((await getAccount(db.storage.engine(), account.id))!.status).toBe("active");
    } finally { await db.close(); }
  });

  it("delete everything only after a disconnect, a preview and the typed name, and exactly what was previewed", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await connectorPage(db.storage, "mail/2026-11/one");
      await connectorPage(db.storage, "mail/2026-11/two");
      await putPage(db.storage, { slug: "mail/notes/mine", markdown_body: "The owner's own note.", source_id: "inbox" });
      const d = deps(db.storage);

      const preview = await call(get(`/admin/api/connectors/accounts/${account.id}/preview`), d);
      const counts = await preview.json() as { pages: number; plan_hash: string };
      expect(counts.pages).toBe(2);
      expect(counts.plan_hash).toMatch(/^[0-9a-f]{16}$/);

      const live = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: counts.plan_hash }), d);
      expect(live.status).toBe(409);
      expect(await live.json()).toMatchObject({ error: "still_connected" });

      await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), d);
      const wrongName = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: "nope", plan_hash: counts.plan_hash }), d);
      expect(wrongName.status).toBe(400);

      await connectorPage(db.storage, "mail/2026-11/three");
      const stale = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: counts.plan_hash }), d);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: "conflict" });
      expect((await e.query("SELECT count(*)::int AS n FROM pages WHERE source_id = 'inbox'")).rows[0]).toEqual({ n: 4 });

      const again = await (await call(get(`/admin/api/connectors/accounts/${account.id}/preview`), d)).json() as { pages: number; plan_hash: string };
      expect(again.pages).toBe(3);
      const done = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: again.plan_hash }), d);
      expect(await done.json()).toEqual({ ok: true, deleted: 3, changed: 0 });
      const left = (await e.query<{ slug: string }>("SELECT slug FROM pages WHERE source_id = 'inbox'")).rows.map((r) => r.slug);
      expect(left).toEqual(["mail/notes/mine"]);
    } finally { await db.close(); }
  });

  it("refuse to preview or delete while another account in the source owns pages under the same name", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      // Same mailbox through another provider, and the same address in other case: page ownership cannot tell them apart.
      for (const [provider, label] of [["test_other", OWNER], ["test", OWNER.toUpperCase()]] as const) {
        const twin = await createAccount(e, { sourceId: "inbox", provider, services: ["mail"], principalRef: "admin:operator", accountLabel: label });
        await connectorPage(db.storage, "mail/2026-11/shared");
        const d = deps(db.storage);
        await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), d);

        const preview = await call(get(`/admin/api/connectors/accounts/${account.id}/preview`), d);
        expect(preview.status).toBe(409);
        expect(await preview.json()).toMatchObject({ error: "shared_owner" });
        const del = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: "0123456789abcdef" }), d);
        expect(del.status).toBe(409);
        expect(await del.json()).toMatchObject({ error: "shared_owner" });
        expect((await e.query("SELECT 1 FROM pages WHERE slug = 'mail/2026-11/shared'")).rows).toHaveLength(1);
        await e.query("DELETE FROM connector_accounts WHERE id = $1", [twin.id]);
      }
    } finally { await db.close(); }
  });

  it("forget the account's sync state with its data, so a reconnect starts over instead of skipping what was deleted", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await connectorPage(db.storage, "mail/2026-11/one");
      await e.query(`INSERT INTO connector_items (account_id, external_id, page_slug, external_version) VALUES ($1, 'one', 'mail/2026-11/one', 'v1')`, [account.id]);
      await e.query(`INSERT INTO connector_cursors (account_id, stream, cursor) VALUES ($1, 'mail', 'history-42')`, [account.id]);
      const d = deps(db.storage);
      await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), d);
      const { plan_hash } = await (await call(get(`/admin/api/connectors/accounts/${account.id}/preview`), d)).json() as { plan_hash: string };
      const done = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash }), d);
      expect(done.status).toBe(200);
      expect((await e.query("SELECT 1 FROM connector_items WHERE account_id = $1", [account.id])).rows).toHaveLength(0);
      expect((await e.query("SELECT 1 FROM connector_cursors WHERE account_id = $1", [account.id])).rows).toHaveLength(0);
      expect(await getAccount(e, account.id)).toMatchObject({ status: "revoked" });
    } finally { await db.close(); }
  });

  it("leave a failed delete-all retryable: sync state never outlives the pages it would block a retry for", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await connectorPage(db.storage, "mail/2026-11/one");
      await e.query(`INSERT INTO connector_items (account_id, external_id, page_slug, external_version) VALUES ($1, 'one', 'mail/2026-11/one', 'v1')`, [account.id]);
      await e.query(`INSERT INTO connector_cursors (account_id, stream, cursor) VALUES ($1, 'mail', 'history-42')`, [account.id]);
      await openNotice(e, account.id, "mass_delete_held", "held");
      const d = deps(db.storage);
      await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), d);
      const preview = async (dd: AdminConnectorDeps) =>
        await (await call(get(`/admin/api/connectors/accounts/${account.id}/preview`), dd)).json() as { pages: number; plan_hash: string };
      const syncState = async () => Number((await e.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM connector_items WHERE account_id = $1) + (SELECT count(*) FROM connector_cursors WHERE account_id = $1)
              + (SELECT count(*) FROM connector_notices WHERE account_id = $1) AS n`, [account.id])).rows[0]!.n);

      // Clearing the sync state fails once.
      let failOnce = true;
      const failing = new Proxy(e, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return async <T>(fn: (tx: Engine) => Promise<T>) => target.transaction(async (tx) => fn(new Proxy(tx, {
              get(t, p2, r2) {
                if (p2 !== "query") return Reflect.get(t, p2, r2);
                return async (sql: string, params?: unknown[]) => {
                  if (failOnce && sql.includes("DELETE FROM connector_cursors")) {
                    failOnce = false;
                    throw new Error("connection reset");
                  }
                  return t.query(sql, params);
                };
              },
            })));
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const flaky = { ...d, storage: new Proxy(db.storage, { get: (t, p2, r2) => (p2 === "engine" ? () => failing : Reflect.get(t, p2, r2)) }) };
      const first = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: (await preview(d)).plan_hash }), flaky);
      expect(first.status).toBe(500);
      expect(await first.json()).toMatchObject({ error: "delete_incomplete" });
      // What is left can still be previewed and deleted: either pages remain, or nothing does at all.
      const left = await preview(d);
      if (left.pages === 0) expect(await syncState()).toBe(0);

      const retry = await call(post(`/admin/api/connectors/accounts/${account.id}/delete-data`, { confirm_label: OWNER, plan_hash: left.plan_hash }), d);
      expect(retry.status).toBe(200);
      expect((await preview(d)).pages).toBe(0);
      expect(await syncState()).toBe(0);
    } finally { await db.close(); }
  });

  it("refuse to switch sync on for a disconnected account, while switching it off still works", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      const d = deps(db.storage);
      await call(post(`/admin/api/connectors/accounts/${account.id}/disconnect`, { confirm_label: OWNER }), d);
      const on = await call(post(`/admin/api/connectors/accounts/${account.id}/enable`), d);
      expect(on.status).toBe(409);
      expect(await on.json()).toMatchObject({ error: "not_connected" });
      expect((await getAccount(e, account.id))!.enabled).toBe(false);
      const off = await call(post(`/admin/api/connectors/accounts/${account.id}/disable`), d);
      expect(off.status).toBe(200);
    } finally { await db.close(); }
  });

  it("confirm or keep the deletions a sync run held, and retry held items", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await e.query(
        `INSERT INTO connector_items (account_id, external_id, page_slug, fail_count, held_reason, deleted_upstream_at) VALUES
           ($1, 'a', 'mail/a', 0, $2, NOW()), ($1, 'b', 'mail/b', 0, $2, NOW()), ($1, 'c', 'mail/c', 4, 'item_error', NULL)`,
        [account.id, MASS_DELETE],
      );
      await openNotice(e, account.id, "mass_delete_held", "held");
      const d = deps(db.storage);

      const confirmed = await call(post(`/admin/api/connectors/accounts/${account.id}/deletions/confirm`), d);
      expect(await confirmed.json()).toEqual({ ok: true, confirmed: 2 });
      const states = (await e.query<{ held_reason: string | null }>(
        "SELECT held_reason FROM connector_items WHERE account_id = $1 ORDER BY external_id", [account.id])).rows.map((r) => r.held_reason);
      expect(states).toEqual(["delete_confirmed", "delete_confirmed", "item_error"]);
      expect((await e.query("SELECT 1 FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL", [account.id])).rows).toHaveLength(0);

      await e.query(`UPDATE connector_items SET held_reason = $2 WHERE account_id = $1 AND external_id = 'a'`, [account.id, MASS_DELETE]);
      const kept = await call(post(`/admin/api/connectors/accounts/${account.id}/deletions/reject`), d);
      expect(await kept.json()).toEqual({ ok: true, kept: 1 });

      const retried = await call(post(`/admin/api/connectors/accounts/${account.id}/retry-held`), d);
      expect(await retried.json()).toEqual({ ok: true, retried: 1 });
    } finally { await db.close(); }
  });

  it("count retention deletions held past the guard with upstream ones, confirm them, and keep them", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await connected(e);
      await e.query(
        `INSERT INTO connector_items (account_id, external_id, page_slug, held_reason, deleted_upstream_at) VALUES
           ($1, 'a', 'mail/a', $2, NOW()), ($1, 'b', 'mail/b', 'retention_held', NULL), ($1, 'c', 'mail/c', 'retention_held', NULL)`,
        [account.id, MASS_DELETE],
      );
      await openNotice(e, account.id, "mass_delete_held", "held");
      const d = deps(db.storage);
      const listed = await (await call(get("/admin/api/connectors"), d)).json() as { accounts: Array<{ held_deletes: number }> };
      expect(listed.accounts[0]!.held_deletes).toBe(3);

      expect(await (await call(post(`/admin/api/connectors/accounts/${account.id}/deletions/confirm`), d)).json()).toEqual({ ok: true, confirmed: 3 });
      const states = async () => (await e.query<{ held_reason: string | null }>(
        "SELECT held_reason FROM connector_items WHERE account_id = $1 ORDER BY external_id", [account.id])).rows.map((r) => r.held_reason);
      expect(await states()).toEqual(["delete_confirmed", "retention_confirmed", "retention_confirmed"]);

      await e.query(`UPDATE connector_items SET held_reason = 'retention_held' WHERE account_id = $1 AND external_id = 'b'`, [account.id]);
      expect(await (await call(post(`/admin/api/connectors/accounts/${account.id}/deletions/reject`), d)).json()).toEqual({ ok: true, kept: 1 });
      // A kept retention deletion stays on record, so the next sweep does not ask again.
      expect(await states()).toEqual(["delete_confirmed", "retention_kept", "retention_confirmed"]);
    } finally { await db.close(); }
  });

  it("remove a bring-your-own client, and refuse an unknown provider", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await setOAuthClient(e, kek, "test", "byo-id", "byo-secret-value");
      const d = deps(db.storage);
      const res = await call(post("/admin/api/connectors/test/client/delete"), d);
      expect(await res.json()).toEqual({ ok: true, deleted: true });
      expect(await getOAuthClient(e, kek, "test")).toBeNull();
      const again = await call(post("/admin/api/connectors/test/client/delete"), d);
      expect(await again.json()).toEqual({ ok: true, deleted: false });
      const unknown = await call(post("/admin/api/connectors/nope/client/delete"), d);
      expect(unknown.status).toBe(400);
    } finally { await db.close(); }
  });
});
