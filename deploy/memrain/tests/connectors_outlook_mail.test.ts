/**
 * The Outlook mail adapter against a recorded Graph mailbox
 * (tests/fixtures/connectors/microsoft-outlook-mail.json), through the real
 * connector runtime and sync engine, on both engines:
 *
 *   - the first sync resolves Inbox and Sent Items by their well-known names,
 *     runs one delta round per folder over the history window
 *     (`receivedDateTime ge`), selects only what grouping needs, never touches
 *     Junk or Deleted Items, and stores one page per conversation with drafts
 *     and junk left out, bodies as text and attachments as receipts;
 *   - a round cut short resumes from its stored @odata.nextLink, without
 *     duplicates; the next round starts from the stored @odata.deltaLink;
 *   - an `@removed` message re-renders its conversation, or, when nothing of
 *     the conversation is left, soft-deletes its page through the upstream
 *     deletion path and its mass-delete guard;
 *   - a lost sync state (410 syncStateNotFound) re-lists the window, writing
 *     nothing twice; a 429 past the wait cap stops the run with its cursor
 *     kept; a refused refresh parks the account for a reconnect.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import {
  addMessage, conversationCalls, deltaCalls, FOLDERS, GRAPH_ACCESS_TOKEN, GRAPH_REFRESH_TOKEN, markRead, moveMessage,
  OUTLOOK_FIXTURES, outlookFetch, outlookTestProvider, outlookWorld, purgeMessage, type GraphMessage, type OutlookWorld,
} from "./helpers/outlook-mail-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, setAccountConfig, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { readCursor } from "../src/core/connectors/sync-store.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { accountRef, shortHash } from "../src/core/connectors/model.ts";
import { OUTLOOK_MAIL_MAX_CONVERSATION_BYTES, OUTLOOK_MAIL_SERVICE, outlookMailStream, parseOutlookMailCursor } from "../src/core/connectors/microsoft/mail.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "outlook";
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
/** A Graph date literal, as the adapter writes one: whole seconds, UTC. */
const gd = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-0000-0000-00000000c0de",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const INBOX = outlookMailStream("inbox");
const SENT = outlookMailStream("sentitems");
const STORED = ["conv-A", "conv-B", "conv-E", "conv-I", "conv-O", "conv-R"];

const slugOf = (conv: string, firstAt: number) =>
  `mail/${accountRef(OWNER)}/${new Date(firstAt).toISOString().slice(0, 7)}/${shortHash(`thread:${conv}`)}`;
const SLUG_A = slugOf("conv-A", T0 - 10 * DAY);
const SLUG_B = slugOf("conv-B", T0 - 20 * DAY);
const SLUG_E = slugOf("conv-E", T0 - 5 * DAY);

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outlook mail sync (${name})`, () => {
  function providers(): ProviderRegistry {
    const r = new ProviderRegistry();
    r.register(outlookTestProvider());
    return r;
  }

  async function connected(storage: Storage, config: Record<string, unknown> = {}): Promise<string> {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
    const account = await createAccount(e, { sourceId: SOURCE, provider: "microsoft", services: [OUTLOOK_MAIL_SERVICE], principalRef: "admin:operator", accountLabel: OWNER });
    await storeCredential(e, kek, account, { access_token: GRAPH_ACCESS_TOKEN, refresh_token: GRAPH_REFRESH_TOKEN }, {
      scopes: ["Mail.Read", "User.Read", "email", "offline_access", "openid"], expiresAt: new Date(T0 + 3_000_000),
    });
    if (Object.keys(config).length > 0) await setAccountConfig(e, account.id, config);
    await setAccountEnabled(e, account.id, true);
    return account.id;
  }

  async function run(storage: Storage, w: OutlookWorld, accountId: string, env: NodeJS.ProcessEnv = ENV, at = T0) {
    const rt = connectorRuntime(storage, {
      kek, providers: providers(), fetch: outlookFetch(w), env, now: () => at, sleep: async () => {},
      embedFn: async (t: string) => deterministicEmbed(t),
    });
    const account = (await rt.loadAccount(accountId))!;
    return runConnectorSync(storage, account, rt.depsFor(account));
  }

  const cursorOf = async (e: Engine, id: string, stream = INBOX) => parseOutlookMailCursor(await readCursor(e, id, stream));
  const livePages = async (e: Engine) =>
    (await e.query<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'mail/%' ORDER BY slug`, [SOURCE])).rows.map(r => r.slug);
  const items = async (e: Engine, id: string) =>
    (await e.query<{ external_id: string }>(`SELECT external_id FROM connector_items WHERE account_id = $1 AND deleted_upstream_at IS NULL ORDER BY external_id`, [id])).rows.map(r => r.external_id);

  it("first sync: one delta round per folder over the window, Junk and Deleted Items untouched, one page per conversation", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      const result = await run(db.storage, w, id);
      expect(result.status).toBe("success");
      expect((await getAccount(e, id))!.last_success_at).not.toBeNull();

      const deltas = deltaCalls(w);
      expect(deltas.map(u => u.pathname)).toEqual(["/v1.0/me/mailFolders/inbox/messages/delta", "/v1.0/me/mailFolders/sentitems/messages/delta"]);
      for (const u of deltas) {
        expect(u.searchParams.get("$filter")).toBe(`receivedDateTime ge ${gd(T0 - 90 * DAY)}`);
        // Grouping needs only these; bodies are read per conversation.
        expect(u.searchParams.get("$select")!.split(",").sort()).toEqual(["conversationId", "parentFolderId", "receivedDateTime"]);
      }
      expect(w.calls.every(c => !/junkemail|deleteditems|drafts/i.test(c.url.pathname))).toBe(true);
      // Every Graph request asks for immutable ids, so a moved message keeps its id.
      expect(w.calls.filter(c => c.url.origin === "https://graph.microsoft.com").every(c => c.prefer?.includes('IdType="ImmutableId"'))).toBe(true);
      const conv = w.calls.find(c => c.url.pathname === "/v1.0/me/messages")!;
      expect(conv.prefer).toContain('outlook.body-content-type="text"');
      expect(conv.url.searchParams.get("$expand")).toBe("attachments($select=name,contentType,size,isInline)");

      expect(await items(e, id)).toEqual(STORED);
      expect(await livePages(e)).toHaveLength(STORED.length);

      const a = (await e.query<{ markdown_body: string; compiled_truth: Record<string, unknown> }>(
        `SELECT markdown_body, compiled_truth FROM pages WHERE slug = $1 AND source_id = $2`, [SLUG_A, SOURCE])).rows[0]!;
      expect(a.compiled_truth).toMatchObject({ origin: "connector", connector: "outlook_mail", trust: "untrusted", external_id: "conv-A", messages: 2 });
      expect(a.compiled_truth.labels).toEqual(["red category"]);
      expect(a.markdown_body).toContain("Can you send the Q4 budget by Friday?");
      expect(a.markdown_body).toContain("Attached is the budget.");
      expect(a.markdown_body.match(/Q4 budget by Friday/g)).toHaveLength(1);
      expect(a.markdown_body).not.toContain("unsent draft text");
      expect(a.markdown_body).toContain("budget-q4.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 18432 bytes)");
      expect(a.markdown_body).not.toContain("image001.png");
      expect(a.markdown_body).toContain("Cc: Stone, Bob <bob@example.org>");
      expect(a.markdown_body).toContain("From: Ana Lee <ana@example.net>");
      // Receipts only: no attachment content is ever fetched.
      expect(w.calls.some(c => c.url.pathname.includes("/attachments") || c.url.search.includes("contentBytes"))).toBe(false);

      const eBody = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [SLUG_E])).rows[0]!.markdown_body;
      expect(eBody).toContain("Can you confirm the venue by Friday?");
      expect(eBody).not.toContain("junk reply text");
      expect(JSON.stringify(await e.query(`SELECT markdown_body FROM pages WHERE source_id = $1`, [SOURCE]))).not.toContain("Claim your prize");
      expect(JSON.stringify(await e.query(`SELECT markdown_body FROM pages WHERE source_id = $1`, [SOURCE]))).not.toContain("From long ago");

      for (const stream of [INBOX, SENT]) {
        const cur = (await cursorOf(e, id, stream))!;
        expect(cur.link).toContain("$deltatoken=");
        expect(cur.linkKind).toBe("delta");
        expect(cur.pending).toBeNull();
      }
      expect(JSON.stringify(result)).not.toContain(OWNER);
      expect(JSON.stringify(result)).not.toContain(GRAPH_ACCESS_TOKEN);
    } finally { await db.close(); }
  });

  it("a first sync past Graph's cap on a filtered delta still stores every conversation in the window", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      // Graph's filtered delta stops at 5,000 messages; here at 3, which leaves the inbox's oldest conversations out.
      const w = outlookWorld({ filteredDeltaCap: 3 });
      expect(w.messages.filter(m => m.parentFolderId === FOLDERS.inbox && Date.parse(m.receivedDateTime) >= T0 - 90 * DAY).length).toBeGreaterThan(3);
      const result = await run(db.storage, w, id);
      expect(result.status).toBe("success");
      expect(await items(e, id)).toEqual(STORED);
      expect(await livePages(e)).toHaveLength(STORED.length);
      // The backfill lists conversation ids only, over the first round's floor, and is not repeated once through.
      const lists = w.calls.filter(c => c.url.pathname === "/v1.0/me/mailFolders/inbox/messages");
      expect(lists).toHaveLength(1);
      expect(lists[0]!.url.searchParams.get("$select")).toBe("conversationId");
      expect(lists[0]!.url.searchParams.get("$filter")).toBe(`receivedDateTime ge ${gd(T0 - 90 * DAY)}`);
      const cur = (await cursorOf(e, id))!;
      expect(cur).toMatchObject({ linkKind: "delta", pending: null });
      expect(cur.backfill).toBeUndefined();
      expect(cur.firstRound).toBeUndefined();
      w.calls.length = 0;
      expect((await run(db.storage, w, id)).status).toBe("nothing_new");
      expect(w.calls.some(c => c.url.pathname.endsWith("/messages") && c.url.pathname.includes("mailFolders"))).toBe(false);
    } finally { await db.close(); }
  });

  it("a round cut short resumes from its stored nextLink on the next run, without duplicates", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      const env = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" };
      const first = await run(db.storage, w, id, env);
      expect(first.status).toBe("partial");
      expect(first.stop_reason).toBe("item_cap_reached");
      const mid = (await cursorOf(e, id))!;
      const stored = mid.pending?.link ?? mid.link;
      expect(stored).toContain("$skiptoken=");

      w.calls.length = 0;
      for (let i = 0; i < 8; i++) {
        const r = await run(db.storage, w, id, env);
        if (r.status === "success" || r.status === "nothing_new") break;
      }
      expect(deltaCalls(w)[0]!.search).toBe(new URL(`https://graph.microsoft.com${stored}`).search);
      expect(await items(e, id)).toEqual(STORED);
      expect(await livePages(e)).toHaveLength(STORED.length);
      expect((await cursorOf(e, id))!.linkKind).toBe("delta");
    } finally { await db.close(); }
  });

  it("the next round starts from the deltaLink: new mail comes in, a read flag alone reads nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      const deltaLink = (await cursorOf(e, id))!.link!;
      addMessage(w, OUTLOOK_FIXTURES.newMail as GraphMessage);
      w.calls.length = 0;
      expect((await run(db.storage, w, id, ENV, T0 + DAY)).status).toBe("success");
      expect(deltaCalls(w)[0]!.pathname + deltaCalls(w)[0]!.search).toBe(deltaLink);
      expect(conversationCalls(w)).toEqual(["conv-N"]);
      expect(await livePages(e)).toContain(slugOf("conv-N", T0 + DAY / 2));

      // A delta entry that carries no conversation (Graph reports only what changed) reads no conversation.
      w.delta = url => (url.searchParams.has("$deltatoken")
        ? { status: 200, body: { value: [{ "@odata.type": "#microsoft.graph.message", "id": "e1", "isRead": true }], "@odata.deltaLink": `https://graph.microsoft.com${(new URL(`https://graph.microsoft.com${deltaLink}`)).pathname}?$deltatoken=after-read` } }
        : undefined);
      markRead(w, "e1");
      w.calls.length = 0;
      expect((await run(db.storage, w, id, ENV, T0 + 2 * DAY)).status).toBe("nothing_new");
      expect(conversationCalls(w)).toEqual([]);
    } finally { await db.close(); }
  });

  it("@removed re-renders the conversation, or soft-deletes its page when nothing of it is left", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      // The reply is deleted (to Deleted Items); the newsletter is purged; Carol's mail goes to Junk.
      moveMessage(w, "a2", "deleteditems");
      purgeMessage(w, "b1");
      moveMessage(w, "e1", "junkemail");
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("success");
      expect(result.counts.deletions_applied).toBe(2);
      const deleted = (await e.query<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL ORDER BY slug`, [SOURCE])).rows.map(r => r.slug);
      expect(deleted.sort()).toEqual([SLUG_B, SLUG_E].sort());
      const a = (await e.query<{ markdown_body: string; deleted_at: unknown }>(`SELECT markdown_body, deleted_at FROM pages WHERE slug = $1`, [SLUG_A])).rows[0]!;
      expect(a.deleted_at).toBeNull();
      expect(a.markdown_body).not.toContain("Attached is the budget.");
      expect(a.markdown_body).toContain("Can you send the Q4 budget by Friday?");
    } finally { await db.close(); }
  });

  it("a purged reply, which Graph can no longer look up, still re-renders its conversation without it", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      purgeMessage(w, "a2");
      w.calls.length = 0;
      expect((await run(db.storage, w, id, ENV, T0 + DAY)).status).toBe("success");
      // The stored conversation names the purged message, so its page is found without Graph.
      expect(conversationCalls(w)).toEqual(["conv-A"]);
      const a = (await e.query<{ markdown_body: string; deleted_at: unknown }>(`SELECT markdown_body, deleted_at FROM pages WHERE slug = $1`, [SLUG_A])).rows[0]!;
      expect(a.deleted_at).toBeNull();
      expect(a.markdown_body).not.toContain("Attached is the budget.");
    } finally { await db.close(); }
  });

  it("holds removals past the mass-delete guard and deletes nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      for (const m of ["b1", "e1", "i1", "r1"]) moveMessage(w, m, "deleteditems");
      const env = { ...ENV, MEMRAIN_CONNECTOR_MASS_DELETE_MIN: "2", MEMRAIN_CONNECTOR_MASS_DELETE_PCT: "10" };
      const result = await run(db.storage, w, id, env, T0 + DAY);
      expect(result.counts.deletions_applied).toBe(0);
      expect(result.counts.deletions_held).toBeGreaterThan(0);
      expect(await livePages(e)).toHaveLength(STORED.length);
    } finally { await db.close(); }
  });

  it("re-lists the window when Graph has lost the sync state, writing nothing twice", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      w.delta = url => (url.searchParams.has("$deltatoken") ? { status: 410, body: OUTLOOK_FIXTURES.error410SyncState } : undefined);
      w.calls.length = 0;
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status === "success" || result.status === "nothing_new").toBe(true);
      const relist = deltaCalls(w).filter(u => u.searchParams.has("$filter"));
      expect(relist.map(u => u.pathname)).toEqual(["/v1.0/me/mailFolders/inbox/messages/delta", "/v1.0/me/mailFolders/sentitems/messages/delta"]);
      expect(relist[0]!.searchParams.get("$filter")).toBe(`receivedDateTime ge ${gd(T0 + DAY - 90 * DAY)}`);
      // The backfill after the re-listed round lists that same window, not the first sync's older floor.
      const lists = w.calls.filter(c => c.url.pathname === "/v1.0/me/mailFolders/inbox/messages");
      expect(lists.map(c => c.url.searchParams.get("$filter"))).toEqual([`receivedDateTime ge ${gd(T0 + DAY - 90 * DAY)}`]);
      expect(await items(e, id)).toEqual(STORED);
      expect(await livePages(e)).toHaveLength(STORED.length);
      expect(result.counts.pages_written).toBe(0);
    } finally { await db.close(); }
  });

  it("stops on a rate limit past the wait cap with its cursor kept, and finishes on the next run", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld({ delta: () => ({ status: 429, body: OUTLOOK_FIXTURES.error429, retryAfter: "3600" }) });
      const first = await run(db.storage, w, id);
      expect(first.status).toBe("partial");
      expect(first.error_class).toBe("rate_limited");
      expect(await readCursor(e, id, INBOX)).toBeNull();
      w.delta = undefined;
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect(await items(e, id)).toEqual(STORED);
    } finally { await db.close(); }
  });

  it("parks the account for a reconnect when Microsoft refuses the refresh, keeping the cursor", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld();
      await run(db.storage, w, id);
      const before = await readCursor(e, id, INBOX);
      w.expired = true;
      w.refuseRefresh = true;
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("auth_required");
      expect(result.stop_reason).toBe("needs_reconnect");
      expect((await getAccount(e, id))!.status).toBe("needs_reconnect");
      expect(await readCursor(e, id, INBOX)).toBe(before);
      expect(JSON.stringify(result)).not.toContain(GRAPH_REFRESH_TOKEN);
    } finally { await db.close(); }
  });

  it("holds a conversation past the size bound with its reason and moves on", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = outlookWorld({
        conversation: c => (c === "conv-B" ? { status: 200, body: { value: [{ id: "b1", body: { contentType: "text", content: "x".repeat(OUTLOOK_MAIL_MAX_CONVERSATION_BYTES + 10) } }] } } : undefined),
      });
      const result = await run(db.storage, w, id);
      expect(result.counts.items_held).toBe(1);
      const held = (await e.query<{ held_reason: string | null; last_error: string | null }>(`SELECT held_reason, last_error FROM connector_items WHERE account_id = $1 AND external_id = 'conv-B'`, [id])).rows[0]!;
      expect(`${held.held_reason} ${held.last_error}`).toContain("too_large");
      expect(await livePages(e)).not.toContain(SLUG_B);
      expect(await livePages(e)).toContain(SLUG_A);
    } finally { await db.close(); }
  });

  it("never reaches past retention, and honours a folder allowlist without Junk or Deleted Items", async () => {
    const db = await open();
    try {
      const id = await connected(db.storage, { history_days: 365, folders: ["inbox", "junkemail", "deleteditems", "archive"] });
      const w = outlookWorld();
      await run(db.storage, w, id, { ...ENV, MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: "60" });
      const deltas = deltaCalls(w);
      expect(deltas.map(u => u.pathname)).toEqual(["/v1.0/me/mailFolders/inbox/messages/delta", "/v1.0/me/mailFolders/archive/messages/delta"]);
      expect(deltas[0]!.searchParams.get("$filter")).toBe(`receivedDateTime ge ${gd(T0 - 60 * DAY)}`);
    } finally { await db.close(); }
  });
});
