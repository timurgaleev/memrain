/**
 * The Gmail adapter against a recorded mailbox (tests/fixtures/connectors/
 * google-gmail.json), on both engines: the history anchor is taken before the
 * backfill; the backfill lists the history window newest first without Spam,
 * Trash, Promotions, Social or drafts, and resumes after an interruption from
 * its page or, when Google no longer takes the page token, from its floor,
 * without duplicates; mail arriving during the backfill comes in through the
 * history feed; deletions and trash go through the upstream soft delete and
 * its mass-delete guard; an expired history id re-lists the window; a refused
 * credential parks the account; a rate limit stops the run with its cursor
 * kept. Threads are one page each, quotes trimmed, attachments as receipts.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fixtureMessages, GMAIL_FIXTURES, gmailFetch, listCalls, plainMessage, threadCalls, type GmailWorld, type RawMessage } from "./helpers/gmail-fake.ts";
import { GOOGLE_ACCESS_TOKEN } from "./helpers/google-calendar-fake.ts";
import { LEAKED_TOKEN } from "./github-recorded.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, setAccountConfig, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { readCursor } from "../src/core/connectors/sync-store.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { accountRef, shortHash } from "../src/core/connectors/model.ts";
import { GOOGLE_GMAIL_READONLY, googleProvider } from "../src/core/connectors/google/provider.ts";
import { GMAIL_MAX_THREAD_BYTES, GMAIL_STREAM, parseGmailCursor } from "../src/core/connectors/google/gmail.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "mail";
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const STORED = ["18c0a1", "18c0b1", "18c0e1", "18c0h1"];

const slugOf = (threadId: string, firstAt: number) =>
  `mail/${accountRef(OWNER)}/${new Date(firstAt).toISOString().slice(0, 7)}/${shortHash(`thread:${threadId}`)}`;
const SLUG_A = slugOf("18c0a1", T0 - 10 * DAY);
const SLUG_B = slugOf("18c0b1", T0 - 20 * DAY);
const SLUG_E = slugOf("18c0e1", T0 - 5 * DAY);

function world(over: Partial<GmailWorld> = {}): GmailWorld {
  return { messages: fixtureMessages(), profile: "profile", history: () => "historyEmpty", calls: [], ...over };
}

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

const count = async (e: Engine, sql: string, params: unknown[] = []) =>
  Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail sync (${name})`, () => {
  function providers(): ProviderRegistry {
    const r = new ProviderRegistry();
    r.register(googleProvider());
    return r;
  }

  async function connected(storage: Storage, config: Record<string, unknown> = {}): Promise<string> {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
    const account = await createAccount(e, { sourceId: SOURCE, provider: "google", services: ["gmail"], principalRef: "admin:operator", accountLabel: OWNER });
    await storeCredential(e, kek, account, { access_token: GOOGLE_ACCESS_TOKEN, refresh_token: "1//test-refresh" }, {
      scopes: ["email", GOOGLE_GMAIL_READONLY, "openid"], expiresAt: new Date(T0 + 3_000_000),
    });
    if (Object.keys(config).length > 0) await setAccountConfig(e, account.id, config);
    await setAccountEnabled(e, account.id, true);
    return account.id;
  }

  async function run(storage: Storage, w: GmailWorld, accountId: string, env: NodeJS.ProcessEnv = ENV, at = T0) {
    const rt = connectorRuntime(storage, {
      kek, providers: providers(), fetch: gmailFetch(w), env, now: () => at, sleep: async () => {},
      embedFn: async (t: string) => deterministicEmbed(t),
    });
    const account = (await rt.loadAccount(accountId))!;
    return runConnectorSync(storage, account, rt.depsFor(account));
  }

  const cursorOf = async (e: Engine, id: string) => parseGmailCursor(await readCursor(e, id, GMAIL_STREAM));
  const livePages = (e: Engine) => e.query<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [SOURCE]);

  it("first sync: anchors history first, lists the window without spam, trash, promotions, social or drafts, one page per thread", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      await putPage(db.storage, { slug: "people/ana-lee", markdown_body: "Ana.", compiled_truth: { aliases: ["ana@example.net"] } });
      const w = world();
      const result = await run(db.storage, w, id);
      expect(result.status).toBe("success");
      expect((await getAccount(e, id))!.last_success_at).not.toBeNull();

      // The anchor comes before any listing.
      const paths = w.calls.map(c => c.url.pathname);
      expect(paths.indexOf("/gmail/v1/users/me/profile")).toBeLessThan(paths.indexOf("/gmail/v1/users/me/messages"));
      const q = listCalls(w)[0]!.get("q")!;
      expect(q).toContain(`after:${Math.floor((T0 - 90 * DAY) / 1000)}`);
      for (const term of ["-in:spam", "-in:trash", "-in:draft", "-category:promotions", "-category:social"]) expect(q).toContain(term);

      const stored = (await e.query<{ external_id: string }>(`SELECT external_id FROM connector_items WHERE account_id = $1 ORDER BY external_id`, [id])).rows;
      expect(stored.map(r => r.external_id)).toEqual(STORED);
      expect((await livePages(e)).rows.map(r => r.slug).filter(s => s.startsWith("mail/"))).toHaveLength(4);

      const a = (await e.query<{ markdown_body: string; compiled_truth: Record<string, unknown> }>(
        `SELECT markdown_body, compiled_truth FROM pages WHERE slug = $1 AND source_id = $2`, [SLUG_A, SOURCE])).rows[0]!;
      expect(a.compiled_truth).toMatchObject({ origin: "connector", connector: "gmail", trust: "untrusted", external_id: "18c0a1", messages: 2 });
      expect(a.compiled_truth.labels).toEqual(["category_personal", "inbox", "sent"]);
      expect(a.markdown_body).toContain("Can you send the Q4 budget by Friday?");
      expect(a.markdown_body).toContain("Attached is the budget.");
      // The reply's quoted history and the draft are not stored.
      expect(a.markdown_body.match(/Q4 budget by Friday/g)).toHaveLength(1);
      expect(a.markdown_body).not.toContain("unsent draft text");
      expect(a.markdown_body).toContain("budget-q4.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 18432 bytes)");
      expect(a.markdown_body).toContain("Cc: Stone, Bob <bob@example.org>");
      // Receipts only: no attachment content is ever fetched.
      expect(w.calls.some(c => c.url.pathname.includes("/attachments"))).toBe(false);
      const links = (await e.query<{ target_slug: string; type: string }>(`SELECT target_slug, type FROM links WHERE source_slug = $1`, [SLUG_A])).rows;
      expect(links).toEqual([{ target_slug: "people/ana-lee", type: "corresponded_with" }]);

      const b = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [SLUG_B])).rows[0]!;
      expect(b.markdown_body).toContain("Top deals this month.");
      expect(b.markdown_body).not.toContain("track()");
      expect(await count(e, `SELECT count(*)::int AS n FROM links WHERE source_slug = $1`, [SLUG_B])).toBe(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM links WHERE source_slug = $1`, [SLUG_E])).toBe(0);
      const h = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [slugOf("18c0h1", T0 - DAY)])).rows[0]!;
      expect(h.markdown_body).toContain("The contract term is twelve months.");

      const cur = (await cursorOf(e, id))!;
      expect(cur.historyId).toBe("120000");
      expect(cur.walk).toBeNull();
      expect(JSON.stringify(result)).not.toContain(OWNER);
      expect(JSON.stringify(result)).not.toContain(GOOGLE_ACCESS_TOKEN);
    } finally { await db.close(); }
  });

  it("a backfill cut short resumes from its page on the next run, without duplicates", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ pageSize: 2 });
      const env = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" };
      const first = await run(db.storage, w, id, env);
      expect(first.status).toBe("partial");
      expect(first.stop_reason).toBe("item_cap_reached");
      const mid = (await cursorOf(e, id))!;
      expect(mid.walk).not.toBeNull();
      expect(mid.walk!.pageToken).not.toBeNull();

      w.calls.length = 0;
      for (let i = 0; i < 5 && (await cursorOf(e, id))!.walk !== null; i++) await run(db.storage, w, id, env);
      // The second run picked the listing up at the stored page.
      expect(listCalls(w)[0]!.get("pageToken")).toBe(mid.walk!.pageToken);
      expect((await cursorOf(e, id))!.walk).toBeNull();
      const items = (await e.query<{ external_id: string }>(`SELECT external_id FROM connector_items WHERE account_id = $1 ORDER BY external_id`, [id])).rows;
      expect(items.map(r => r.external_id)).toEqual(STORED);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).toBe(4);
    } finally { await db.close(); }
  });

  it("resumes from its floor when Google no longer takes the stored page token", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ pageSize: 2 });
      const env = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" };
      await run(db.storage, w, id, env);
      const mid = (await cursorOf(e, id))!;
      w.list = q => (q.get("pageToken") === mid.walk!.pageToken ? { status: 400, body: GMAIL_FIXTURES.error400InvalidPageToken } : undefined);
      w.calls.length = 0;
      await run(db.storage, w, id, ENV);
      const lists = listCalls(w);
      expect(lists[0]!.get("pageToken")).toBe(mid.walk!.pageToken);
      expect(lists[1]!.get("pageToken")).toBeNull();
      expect(lists[1]!.get("q")).toContain(`before:${Math.ceil(mid.walk!.resumeFloorMs / 1000)}`);
      expect((await cursorOf(e, id))!.walk).toBeNull();
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).toBe(4);
    } finally { await db.close(); }
  });

  it("mail that arrives during the backfill comes in through history; a read receipt alone fetches nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ pageSize: 2 });
      await run(db.storage, w, id, { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" });
      // New mail lands after the anchor, newer than anything the backfill lists.
      w.messages.push(GMAIL_FIXTURES.newMail as RawMessage);
      w.history = start => (start === "120000" ? "historyDelta" : "historyEmpty");
      w.calls.length = 0;
      for (let i = 0; i < 5 && (await cursorOf(e, id))!.walk !== null; i++) await run(db.storage, w, id, ENV, T0 + DAY);
      const n = slugOf("18c0n1", T0 + 30 * 60_000);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [n])).toBe(1);
      expect((await cursorOf(e, id))!.historyId).toBe("120020");
      expect(threadCalls(w).filter(t => t === "18c0n1")).toHaveLength(1);

      // Once the backfill is through, a record that only marks thread A read reads no thread.
      const unreadOnly = (GMAIL_FIXTURES.historyDelta as { history: unknown[] }).history[1];
      w.history = start => (start === "120020" ? { status: 200, body: { history: [unreadOnly], historyId: "120025" } } : "historyEmpty");
      w.calls.length = 0;
      expect((await run(db.storage, w, id, ENV, T0 + 2 * DAY)).status).toBe("nothing_new");
      expect(threadCalls(w)).toEqual([]);
      expect((await cursorOf(e, id))!.historyId).toBe("120025");
    } finally { await db.close(); }
  });

  it("history deletions and trash soft-delete their pages; a deleted reply re-renders its thread", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      await run(db.storage, w, id);
      w.messages = w.messages
        .filter(m => m.id !== "18c0b1" && m.id !== "18c0a2")
        .map(m => (m.id === "18c0e1" ? { ...m, labelIds: ["TRASH"] } : m));
      w.history = start => (start === "120000" ? "historyDeletion" : "historyEmpty");
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("success");
      expect(result.counts.deletions_applied).toBe(2);
      const deleted = (await e.query<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL ORDER BY slug`, [SOURCE])).rows.map(r => r.slug);
      expect(deleted.sort()).toEqual([SLUG_B, SLUG_E].sort());
      const a = (await e.query<{ markdown_body: string; deleted_at: unknown }>(`SELECT markdown_body, deleted_at FROM pages WHERE slug = $1`, [SLUG_A])).rows[0]!;
      expect(a.deleted_at).toBeNull();
      expect(a.markdown_body).not.toContain("Attached is the budget.");
      expect((await cursorOf(e, id))!.historyId).toBe("120040");
    } finally { await db.close(); }
  });

  it("a thread whose first message is deleted moves to its new slug and leaves no page behind with the deleted text", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const first = T0 - 50 * DAY; // September
      const reply = T0 - 10 * DAY; // November
      const w = world({ messages: [
        plainMessage("18c0m1", "18c0m1", first, { From: "Ana Lee <ana@example.net>", To: OWNER, Subject: "Offer" }, "The private first message."),
        plainMessage("18c0m2", "18c0m1", reply, { From: OWNER, To: "ana@example.net", Subject: "Re: Offer" }, "My reply."),
      ] });
      await run(db.storage, w, id);
      const oldSlug = slugOf("18c0m1", first);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [oldSlug])).toBe(1);

      w.messages = w.messages.filter(m => m.id !== "18c0m1");
      w.history = start => (start === "120000"
        ? { status: 200, body: { history: [{ id: "120050", messagesDeleted: [{ message: { id: "18c0m1", threadId: "18c0m1" } }] }], historyId: "120060" } }
        : "historyEmpty");
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("success");
      const newSlug = slugOf("18c0m1", reply);
      expect(newSlug).not.toBe(oldSlug);
      const live = (await e.query<{ slug: string; markdown_body: string }>(
        `SELECT slug, markdown_body FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'mail/%'`, [SOURCE])).rows;
      expect(live.map(r => r.slug)).toEqual([newSlug]);
      expect(live[0]!.markdown_body).not.toContain("The private first message.");
      // The old page went through the recoverable soft delete, not a hard one.
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NOT NULL`, [oldSlug])).toBe(1);
    } finally { await db.close(); }
  });

  it("keeps messages older than the first sync's window out of a thread a recent reply brings in", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ messages: [
        plainMessage("18c0w1", "18c0w1", T0 - 200 * DAY, { From: "Ana Lee <ana@example.net>", To: OWNER, Subject: "Lease" }, "Text from long ago."),
        plainMessage("18c0w2", "18c0w1", T0 - 5 * DAY, { From: OWNER, To: "ana@example.net", Subject: "Re: Lease" }, "A recent reply."),
      ] });
      await run(db.storage, w, id);
      const body = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [slugOf("18c0w1", T0 - 5 * DAY)])).rows[0]!.markdown_body;
      expect(body).toContain("A recent reply.");
      expect(body).not.toContain("Text from long ago.");
      // The floor stays where the first sync put it.
      expect((await cursorOf(e, id))!.floorMs).toBe(T0 - 90 * DAY);
    } finally { await db.close(); }
  });

  it("drains a history page that touches more threads than one run may store, over several runs", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ messages: [] });
      await run(db.storage, w, id);
      const fresh = Array.from({ length: 5 }, (_, i) => plainMessage(`18c1${i}`, `18c1${i}`, T0 + i * 60_000, { From: "c@example.com", To: OWNER, Subject: `New ${i}` }, `Body ${i}.`));
      w.messages.push(...fresh);
      const page = { history: fresh.map((m, i) => ({ id: `12010${i}`, messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })), historyId: "120200" };
      w.history = start => (start === "120000" ? { status: 200, body: page } : "historyEmpty");
      const env = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" };
      for (let i = 0; i < 6 && (await cursorOf(e, id))!.historyId !== "120200"; i++) await run(db.storage, w, id, env, T0 + DAY + i);
      expect((await cursorOf(e, id))!.historyId).toBe("120200");
      expect(await count(e, `SELECT count(*)::int AS n FROM connector_items WHERE account_id = $1`, [id])).toBe(5);
    } finally { await db.close(); }
  });

  it("holds deletions past the mass-delete guard and deletes nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      await run(db.storage, w, id);
      w.messages = w.messages.filter(m => m.id !== "18c0b1").map(m => (m.id === "18c0e1" ? { ...m, labelIds: ["TRASH"] } : m));
      w.history = start => (start === "120000" ? "historyDeletion" : "historyEmpty");
      const result = await run(db.storage, w, id, { ...ENV, MEMRAIN_CONNECTOR_MASS_DELETE_MIN: "1", MEMRAIN_CONNECTOR_MASS_DELETE_PCT: "10" }, T0 + DAY);
      expect(result.counts.deletions_held).toBe(2);
      expect(result.counts.deletions_applied).toBe(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL`, [SOURCE])).toBe(0);
    } finally { await db.close(); }
  });

  it("re-anchors and re-lists the window when the history id has expired, writing no duplicates", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      await run(db.storage, w, id);
      w.history = start => (start === "120000" ? { status: 404, body: GMAIL_FIXTURES.error404History } : "historyEmpty");
      w.profile = "profileAfterExpiry";
      w.calls.length = 0;
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("success");
      expect(result.counts.pages_written).toBe(0);
      const q = listCalls(w)[0]!.get("q")!;
      // The whole window as of this run.
      expect(q).toContain(`after:${Math.floor((T0 + DAY - 90 * DAY) / 1000)}`);
      const cur = (await cursorOf(e, id))!;
      expect(cur.historyId).toBe("150000");
      expect(cur.walk).toBeNull();
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).toBe(4);
    } finally { await db.close(); }
  });

  it("treats a thread answer with unreadable messages as a failed read, deleting nothing and keeping the cursor", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      await run(db.storage, w, id);
      const before = await readCursor(e, id, GMAIL_STREAM);
      const live = (await livePages(e)).rows.map(r => r.slug);
      w.history = start => (start === "120000" ? "historyDeletion" : "historyEmpty");
      const bodies = async () => (await e.query<{ slug: string; markdown_body: string }>(`SELECT slug, markdown_body FROM pages WHERE source_id = $1 ORDER BY slug`, [SOURCE])).rows;
      const stored = await bodies();
      const unreadable = [
        (tid: string) => ({ id: `${tid}-x`, threadId: tid }),
        (tid: string) => ({ id: `${tid}-x`, threadId: tid, internalDate: String(T0), labelIds: ["INBOX"] }),
      ];
      for (const message of unreadable) {
        w.thread = tid => ({ status: 200, body: { id: tid, historyId: "120099", messages: [message(tid)] } });
        const result = await run(db.storage, w, id, ENV, T0 + DAY);
        expect(result.status).not.toBe("success");
        expect(result.counts.deletions_applied ?? 0).toBe(0);
        expect((await livePages(e)).rows.map(r => r.slug)).toEqual(live);
        expect(await bodies()).toEqual(stored);
        expect(await readCursor(e, id, GMAIL_STREAM)).toBe(before);
      }
    } finally { await db.close(); }
  });

  it("parks the account for a reconnect when Google refuses the credential, keeping the cursor", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      await run(db.storage, w, id);
      const before = await readCursor(e, id, GMAIL_STREAM);
      w.expired = true;
      w.refuseRefresh = true;
      const result = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(result.status).toBe("auth_required");
      expect((await getAccount(e, id))!.status).toBe("needs_reconnect");
      expect(await readCursor(e, id, GMAIL_STREAM)).toBe(before);
    } finally { await db.close(); }
  });

  it("holds a thread past the size bound with its reason, keeps its existing page, and moves on", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      // Past the bound: a thread whose body would be read whole into memory.
      const huge = JSON.stringify({ id: "18c0a1", historyId: "120099", messages: [], pad: "x".repeat(GMAIL_MAX_THREAD_BYTES) });
      const w = world({ thread: tid => (tid === "18c0b1" ? { status: 200, body: huge } : undefined) });
      const first = await run(db.storage, w, id);
      expect(first.counts.items_held).toBe(1);
      expect((await cursorOf(e, id))!.walk).toBeNull();
      const heldB = (await e.query<{ held_reason: string | null; last_error: string | null; page_slug: string | null }>(
        `SELECT held_reason, last_error, page_slug FROM connector_items WHERE account_id = $1 AND external_id = '18c0b1'`, [id])).rows[0]!;
      expect(heldB.held_reason).toBe("too_large");
      expect(heldB.last_error).toContain("larger than");
      expect(heldB.page_slug).toBeNull();
      expect((await livePages(e)).rows.map(r => r.slug)).not.toContain(SLUG_B);

      // A stored thread that grows past the bound is held too; its page stays.
      w.thread = tid => (tid === "18c0a1" ? { status: 200, body: huge } : undefined);
      w.history = start => (start === "120000"
        ? { status: 200, body: { history: [{ id: "120010", messagesAdded: [{ message: { id: "18c0a9", threadId: "18c0a1" } }] }], historyId: "120010" } }
        : "historyEmpty");
      const second = await run(db.storage, w, id, ENV, T0 + DAY);
      expect(second.counts.items_held).toBe(1);
      expect(second.counts.deletions_seen).toBe(0);
      expect((await cursorOf(e, id))!.historyId).toBe("120010");
      expect((await livePages(e)).rows.map(r => r.slug)).toContain(SLUG_A);
      const heldA = (await e.query<{ held_reason: string | null; page_slug: string | null; deleted_upstream_at: Date | null }>(
        `SELECT held_reason, page_slug, deleted_upstream_at FROM connector_items WHERE account_id = $1 AND external_id = '18c0a1'`, [id])).rows[0]!;
      expect(heldA).toMatchObject({ held_reason: "too_large", page_slug: SLUG_A, deleted_upstream_at: null });
    } finally { await db.close(); }
  });

  it("stops on a rate limit with its cursor kept, and finishes on the next run", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ thread: () => ({ status: 429, body: GMAIL_FIXTURES.error429 }) });
      const result = await run(db.storage, w, id);
      expect(result.status).toBe("partial");
      expect(result.error_class).toBe("rate_limited");
      expect((await cursorOf(e, id))!.walk).not.toBeNull();
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).toBe(0);
      delete w.thread;
      expect((await run(db.storage, w, id, ENV, T0 + 60_000)).status).toBe("success");
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).toBe(4);
    } finally { await db.close(); }
  });

  it("stores a mail carrying a credential with the credential cut out, even under reject", async () => {
    const db = await open();
    const saved = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ messages: [plainMessage("18c0s1", "18c0s1", T0 - DAY, { From: "Service <noreply@svc.example>", To: OWNER, Subject: "Your token" }, `Use ${LEAKED_TOKEN} to sign in.`)] });
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
      const result = await run(db.storage, w, id);
      expect(result.counts.items_failed).toBe(0);
      const body = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE source_id = $1 AND slug LIKE 'mail/%'`, [SOURCE])).rows[0]!.markdown_body;
      expect(body).not.toContain(LEAKED_TOKEN);
      expect(body).toContain("[REDACTED:github-token:");
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
      else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = saved;
      await db.close();
    }
  });

  it("never reaches past retention: the window is the shorter of history_days and the mail retention", async () => {
    const db = await open();
    try {
      const id = await connected(db.storage, { history_days: 365 });
      const w = world();
      await run(db.storage, w, id);
      expect(listCalls(w)[0]!.get("q")).toContain(`after:${Math.floor((T0 - 180 * DAY) / 1000)}`);
    } finally { await db.close(); }
  });

  it("a daily item cap smaller than a page still moves the backfill forward, day by day", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      await e.query(`UPDATE connector_accounts SET item_cap_daily = 3 WHERE id = $1`, [id]);
      const messages = Array.from({ length: 5 }, (_, i) =>
        plainMessage(`cap${i}`, `cap${i}`, T0 - (i + 1) * DAY, { From: "peer@example.net", To: OWNER, Subject: `Note ${i}` }, `Note ${i}.`));
      const w = world({ messages });
      await run(db.storage, w, id);
      await run(db.storage, w, id, ENV, T0 + DAY);
      const stored = (await e.query<{ external_id: string }>(`SELECT external_id FROM connector_items WHERE account_id = $1 ORDER BY external_id`, [id])).rows;
      expect(stored.map(r => r.external_id)).toEqual(messages.map(m => m.threadId).sort());
    } finally { await db.close(); }
  });
});
