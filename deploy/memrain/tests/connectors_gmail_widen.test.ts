/**
 * Widening a Gmail account's history window, on both engines: a widened
 * window backfills exactly the older threads below what the listings covered
 * (a cursor written before the covered bound was kept included), re-admits
 * nothing already stored, keeps the backfilled history when a reply arrives,
 * re-renders a stored thread that spans the old floor as one item, survives a
 * rollback to code that drops the new cursor fields, and narrowing mid-way
 * keeps the covered bound where the listing really reached. The
 * `connectors gmail-widen` dry run writes nothing and prints counts and a plan
 * hash; `--apply` refuses a stale hash or an incomplete listing.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { gmailFetch, plainMessage, threadCalls, type GmailWorld, type RawMessage } from "./helpers/gmail-fake.ts";
import { GOOGLE_ACCESS_TOKEN } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, setAccountConfig, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { readCursor, writeCursor } from "../src/core/connectors/sync-store.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { GOOGLE_GMAIL_READONLY, googleProvider } from "../src/core/connectors/google/provider.ts";
import { GMAIL_STREAM, parseGmailCursor, type GmailCursor } from "../src/core/connectors/google/gmail.ts";
import { runGmailWiden } from "../src/commands/connectors-gmail-widen.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(120_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "mail";
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const CAP2 = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" };

const one = (tid: string, at: number, text = `Body of ${tid}.`): RawMessage =>
  plainMessage(`${tid}m`, tid, at, { "From": "Peer Example <peer@example.net>", "To": OWNER, "Subject": `Topic ${tid}`, "Message-ID": `<${tid}@example.net>` }, text);

const RECENT = Array.from({ length: 3 }, (_, i) => one(`r${i}`, T0 - (i + 1) * DAY));
const OLD = Array.from({ length: 25 }, (_, i) => one(`o${i}`, T0 - (92 + i) * DAY));

/** What code that predates the covered bound writes back: only the fields it knows. */
function strip(c: GmailCursor): string {
  const { v, historyId, historyPage, pending, floorMs, walk } = c;
  return JSON.stringify({ v, historyId, historyPage, pending, floorMs, walk });
}

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

const count = async (e: Engine, sql: string, params: unknown[] = []) => Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail window widening (${name})`, () => {
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

  const world = (messages: RawMessage[], over: Partial<GmailWorld> = {}): GmailWorld =>
    ({ messages: structuredClone(messages), profile: "profile", history: () => "historyEmpty", calls: [], ...over });
  const cursorOf = async (e: Engine, id: string) => parseGmailCursor(await readCursor(e, id, GMAIL_STREAM));
  const items = async (e: Engine, id: string) =>
    (await e.query<{ external_id: string }>(`SELECT external_id FROM connector_items WHERE account_id = $1 ORDER BY external_id`, [id])).rows.map(r => r.external_id);
  const bodyOf = async (e: Engine, id: string, threadId: string) => (await e.query<{ markdown_body: string }>(
    `SELECT p.markdown_body FROM connector_items i JOIN pages p ON p.slug = i.page_slug AND p.source_id = $3 AND p.deleted_at IS NULL
      WHERE i.account_id = $1 AND i.external_id = $2`, [id, threadId, SOURCE])).rows.map(r => r.markdown_body);

  // Value: protects=a widened window reaches the older mail of a cursor written before the covered bound; fails_when=the floor never moves or the stored threads are read again; why_new=widening never backfilled; seam=recorded Gmail fake through the real runtime.
  it("widening a legacy cursor from 90 to 120 days imports exactly the older threads, re-admitting nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect(await items(e, id)).toEqual(["r0", "r1", "r2"]);
      // The cursor as code before the covered bound wrote it.
      const first = (await cursorOf(e, id))!;
      expect(first.coveredLowMs).toBe(first.floorMs);
      await writeCursor(e, id, GMAIL_STREAM, strip(first), new Date(T0));

      await setAccountConfig(e, id, { gmail_history_days: 120 });
      w.calls.length = 0;
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect(threadCalls(w).sort()).toEqual(OLD.map(m => m.threadId).sort());
      expect(await items(e, id)).toEqual([...OLD, ...RECENT].map(m => m.threadId).sort());
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`, [SOURCE])).toBe(28);
      const done = (await cursorOf(e, id))!;
      expect(done.backfill).toBeNull();
      expect(done.widenFloorMs).toBeNull();
      expect(done.floorMs).toBe(T0 - 120 * DAY);
      expect(done.coveredLowMs).toBe(T0 - 120 * DAY);

      // Nothing left to backfill: the next run reads no thread.
      w.calls.length = 0;
      expect((await run(db.storage, w, id, ENV, T0 + HOUR)).status).toBe("nothing_new");
      expect(threadCalls(w)).toEqual([]);
    } finally { await db.close(); }
  });

  // Value: protects=saving the calendar picker never starts a Gmail backfill; fails_when=the shared history_days key the picker writes (admin-connectors.ts calendarsAction) widens the Gmail window and skips the dry run, page cap and plan hash; why_new=review finding (HIGH); seam=the exact config patch the picker saves. Regression proof: red while Gmail widened on history_days.
  it("a calendar-picker save of history_days starts no Gmail backfill", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      const before = (await cursorOf(e, id))!;
      await setAccountConfig(e, id, { calendars: [], history_days: 365 });
      w.calls.length = 0;
      await run(db.storage, w, id, ENV, T0 + HOUR);
      expect(threadCalls(w)).toEqual([]);
      expect(await items(e, id)).toEqual(["r0", "r1", "r2"]);
      const after = (await cursorOf(e, id))!;
      expect(after.backfill).toBeNull();
      expect(after.floorMs).toBe(before.floorMs);
      expect(after.coveredLowMs).toBe(before.coveredLowMs);

      // An expired history id then relists only the covered window, not the picker's 365 days.
      w.history = start => (start === "120020" ? { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } } : { status: 200, body: { historyId: start } });
      w.profile = "profileAfterExpiry";
      w.calls.length = 0;
      await run(db.storage, w, id, ENV, T0 + 2 * HOUR);
      expect(threadCalls(w).sort()).toEqual(["r0", "r1", "r2"]);
      expect(await items(e, id)).toEqual(["r0", "r1", "r2"]);
    } finally { await db.close(); }
  });

  // Value: protects=a cursor that never kept a floor takes no window from the picker's history_days when its history expires; fails_when=the floorless fallback reads the shared key and the relist backfills the wider window; why_new=review finding; seam=a cursor as the oldest code wrote it. Regression proof: red while the fallback read history_days.
  it("a floorless cursor relisted after a picker save keeps to the default window", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      await writeCursor(e, id, GMAIL_STREAM, JSON.stringify({ v: 1, historyId: "120020", historyPage: null, pending: null, floorMs: null, walk: null }), new Date(T0));
      await setAccountConfig(e, id, { calendars: [], history_days: 365 });
      w.history = start => (start === "120020" ? { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } } : { status: 200, body: { historyId: start } });
      w.profile = "profileAfterExpiry";
      w.calls.length = 0;
      await run(db.storage, w, id);
      expect(threadCalls(w).sort()).toEqual(["r0", "r1", "r2"]);
      expect(await items(e, id)).toEqual(["r0", "r1", "r2"]);
      expect((await cursorOf(e, id))!.floorMs).toBe(T0 - 90 * DAY);
    } finally { await db.close(); }
  });

  // Value: protects=narrowing mid-backfill records what was really covered, and widening again fetches only the gap; fails_when=covered jumps to the narrow window (mail skipped) or stays put (mail read twice); why_new=new behavior; seam=recorded Gmail fake.
  it("narrowing mid-backfill keeps the covered bound; widening again fetches only the missing threads, and wider still only the newer gap", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage, { history_days: 30 });
      const archive = [40, 50, 60, 70, 80, 90].map((d, i) => one(`d${i}`, T0 - d * DAY));
      const w = world(archive);
      await run(db.storage, w, id);
      expect(await items(e, id)).toEqual([]);

      await setAccountConfig(e, id, { gmail_history_days: 120 });
      const partial = await run(db.storage, w, id, CAP2);
      expect(partial.stop_reason).toBe("item_cap_reached");
      expect(await items(e, id)).toEqual(["d0", "d1"]);
      expect((await cursorOf(e, id))!.backfill!.resumeFloorMs).toBe(T0 - 50 * DAY);

      // A 4-day window: nothing is fetched, and the covered bound is the 50 days really listed.
      await setAccountConfig(e, id, { gmail_history_days: 4 });
      w.calls.length = 0;
      await run(db.storage, w, id);
      expect(threadCalls(w)).toEqual([]);
      const narrowed = (await cursorOf(e, id))!;
      expect(narrowed.backfill).toBeNull();
      expect(narrowed.coveredLowMs).toBe(T0 - 50 * DAY);
      // The floor drops no lower than the listing reached.
      expect(narrowed.floorMs).toBe(T0 - 50 * DAY);

      // Back to 120 days: only the four unread archive threads.
      await setAccountConfig(e, id, { gmail_history_days: 120 });
      w.calls.length = 0;
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect(threadCalls(w).sort()).toEqual(["d2", "d3", "d4", "d5"]);
      expect(await items(e, id)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5"]);

      // Wider still (capped by the 180-day mail retention): only the gap below 120 days.
      w.messages.push(one("d9", T0 - 150 * DAY));
      await setAccountConfig(e, id, { gmail_history_days: 200 });
      w.calls.length = 0;
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect(threadCalls(w)).toEqual(["d9"]);
      expect((await cursorOf(e, id))!.coveredLowMs).toBe(T0 - 180 * DAY);
    } finally { await db.close(); }
  });

  // Value: protects=a reply to an older thread during and after a backfill keeps the older messages; fails_when=history reads normalize with the old floor while the backfill is open, cutting the thread short again; why_new=new behavior; seam=recorded Gmail fake with a history record.
  it("a reply arriving to an older thread mid-backfill keeps all its messages", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      await setAccountConfig(e, id, { gmail_history_days: 120 });
      // The backfill reads the two newest archive threads, then stops at the run cap.
      expect((await run(db.storage, w, id, CAP2)).stop_reason).toBe("item_cap_reached");
      expect((await cursorOf(e, id))!.backfill).not.toBeNull();

      // A reply to the oldest archive thread, which the backfill has not reached.
      const oldest = OLD.at(-1)!;
      const reply = plainMessage("o24reply", oldest.threadId, T0 + HOUR,
        { "From": `Owner <${OWNER}>`, "To": "peer@example.net", "Subject": "Re: Topic o24", "Message-ID": "<o24reply@example.test>" }, "Answering this at last.", ["SENT"]);
      w.messages.push(reply);
      w.history = start => (start === "120020"
        ? { status: 200, body: { history: [{ id: "120025", messagesAdded: [{ message: { id: reply.id, threadId: reply.threadId, labelIds: ["SENT"] } }] }], historyId: "120030" } }
        : { status: 200, body: { historyId: start } });
      await run(db.storage, w, id, CAP2, T0 + 2 * HOUR);
      const [body] = await bodyOf(e, id, oldest.threadId);
      expect(body).toContain("Body of o24.");
      expect(body).toContain("Answering this at last.");

      // Once the backfill is through, the thread still holds both.
      for (let i = 0; i < 20 && (await cursorOf(e, id))!.backfill !== null; i++) await run(db.storage, w, id, CAP2, T0 + 2 * HOUR);
      expect((await cursorOf(e, id))!.backfill).toBeNull();
      const after = await bodyOf(e, id, oldest.threadId);
      expect(after).toHaveLength(1);
      expect(after[0]).toContain("Body of o24.");
      expect(after[0]).toContain("Answering this at last.");
      expect(await items(e, id)).toHaveLength(28);
    } finally { await db.close(); }
  });

  // Value: protects=a rollback mid-backfill leaves the old floor intact, and the next run of this code reopens the gap; fails_when=the floor drops before the backfill completes, so a stripped cursor treats the gap as covered; why_new=rollback contract for the new optional fields; seam=the cursor as older code writes it back.
  it("a cursor written mid-backfill keeps the old floor for older code; a run on the stripped cursor reopens and finishes the backfill", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      const oldFloor = (await cursorOf(e, id))!.floorMs;
      expect(oldFloor).toBe(T0 - 90 * DAY);
      await setAccountConfig(e, id, { gmail_history_days: 120 });
      await run(db.storage, w, id, CAP2);
      const mid = (await cursorOf(e, id))!;
      expect(mid.backfill).not.toBeNull();
      expect(mid.widenFloorMs).toBe(T0 - 120 * DAY);

      // Older code keeps exactly these fields: the history anchor and the old floor survive.
      const stripped = JSON.parse(strip(mid)) as Record<string, unknown>;
      expect(Object.keys(stripped).sort()).toEqual(["floorMs", "historyId", "historyPage", "pending", "v", "walk"]);
      expect(stripped).toMatchObject({ v: 1, historyId: mid.historyId, floorMs: oldFloor, walk: null });
      await writeCursor(e, id, GMAIL_STREAM, strip(mid), new Date(T0));
      const reread = (await cursorOf(e, id))!;
      expect(reread.coveredLowMs).toBe(oldFloor);
      expect(reread.backfill).toBeNull();

      for (let i = 0; i < 20; i++) {
        await run(db.storage, w, id);
        if ((await cursorOf(e, id))!.backfill === null) break;
      }
      expect(await items(e, id)).toEqual([...OLD, ...RECENT].map(m => m.threadId).sort());
      expect((await cursorOf(e, id))!.floorMs).toBe(T0 - 120 * DAY);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`, [SOURCE])).toBe(28);
    } finally { await db.close(); }
  });

  // Value: protects=an expired history id mid-backfill costs no second read of a backfill thread; fails_when=the relist walk covers the backfill's range too; why_new=new interaction; seam=recorded Gmail fake with an expired history id.
  it("an expired history id mid-backfill relists only the covered window: no thread is read twice", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      await setAccountConfig(e, id, { gmail_history_days: 120 });
      await run(db.storage, w, id, CAP2);
      const mid = (await cursorOf(e, id))!;
      expect(mid.backfill).not.toBeNull();
      w.history = start => (start === "120020" ? { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } } : { status: 200, body: { historyId: start } });
      w.profile = "profileAfterExpiry";
      w.calls.length = 0;
      for (let i = 0; i < 20; i++) {
        await run(db.storage, w, id, ENV, T0 + HOUR);
        const c = (await cursorOf(e, id))!;
        if (c.walk === null && c.backfill === null) break;
      }
      const reads = threadCalls(w);
      expect(reads.length).toBe(new Set(reads).size);
      expect(await items(e, id)).toEqual([...OLD, ...RECENT].map(m => m.threadId).sort());
      expect((await cursorOf(e, id))!.floorMs).toBe(T0 - 120 * DAY);
    } finally { await db.close(); }
  });

  // Value: protects=a stored thread with mail on both sides of the old floor gets its older messages, as one item; fails_when=the same-version skip keeps the truncated page, or the thread becomes a second item; why_new=new behavior; seam=recorded Gmail fake.
  it("re-renders a stored thread that spans the old floor with its older messages, still one item", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      // Both in August: the page keeps its slug, so only the version can tell the engine to render it again.
      const span = [one("sp", T0 - 95 * DAY, "The opening message."), { ...one("sp", T0 - 88 * DAY, "The recent answer."), id: "spm2" }];
      const w = world(span);
      await run(db.storage, w, id);
      const slug = (await e.query<{ page_slug: string }>(`SELECT page_slug FROM connector_items WHERE account_id = $1`, [id])).rows[0]!.page_slug;
      const [before] = await bodyOf(e, id, "sp");
      expect(before).toContain("The recent answer.");
      expect(before).not.toContain("The opening message.");

      await setAccountConfig(e, id, { gmail_history_days: 120 });
      expect((await run(db.storage, w, id)).status).toBe("success");
      const after = await bodyOf(e, id, "sp");
      expect(after).toHaveLength(1);
      expect(after[0]).toContain("The opening message.");
      expect(after[0]).toContain("The recent answer.");
      expect(await count(e, `SELECT count(*)::int AS n FROM connector_items WHERE account_id = $1 AND external_id = 'sp'`, [id])).toBe(1);
      expect((await e.query<{ page_slug: string }>(`SELECT page_slug FROM connector_items WHERE account_id = $1`, [id])).rows[0]!.page_slug).toBe(slug);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE])).toBe(1);
    } finally { await db.close(); }
  });

  async function widen(storage: Storage, w: GmailWorld, args: { accountId: string; days: string; apply?: boolean; planHash?: string }): Promise<{ code: number; out: Record<string, unknown> }> {
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (s: unknown) => { lines.push(String(s)); };
    console.error = (s: unknown) => { lines.push(String(s)); };
    try {
      const code = await runGmailWiden({
        ...args, json: true, storage, fetch: gmailFetch(w), now: () => T0, env: ENV, kek, providers: providers(), sleep: async () => {},
      });
      return { code, out: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    } finally {
      console.log = log;
      console.error = err;
    }
  }

  // Value: protects=the dry run writes nothing and its counts match what the backfill then does; a stale hash changes nothing; fails_when=the preview writes config or items, or apply ignores the hash; why_new=new command; seam=the command with recorded Gmail and a real store.
  it("gmail-widen: the dry run writes nothing and counts the gap; a wrong hash is refused; the right one sets the window", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const span = [one("sp", T0 - 100 * DAY, "The opening message."), { ...one("sp", T0 - 10 * DAY, "The recent answer."), id: "spm2" }];
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD, ...span]);
      await run(db.storage, w, id);
      const snapshot = async () => ({
        config: (await getAccount(e, id))!.config,
        items: await items(e, id),
        pages: await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE]),
        cursor: await readCursor(e, id, GMAIL_STREAM),
      });
      const before = await snapshot();

      const dry = await widen(db.storage, w, { accountId: id, days: "120" });
      expect(dry.code).toBe(0);
      expect(dry.out).toMatchObject({
        ok: true, dry_run: true, days: 120, current_days: 90, threads_in_range: 26, already_stored_spanning: 1, would_add: 25,
        would_move_in_backfill: 1, truncated: false, covered_low: new Date(T0 - 90 * DAY).toISOString(), new_low: new Date(T0 - 120 * DAY).toISOString(),
      });
      expect(Number(dry.out.quota_units)).toBeGreaterThan(0);
      expect(Number(dry.out.est_embed_usd)).toBeLessThan(0.1);
      expect(String(dry.out.plan_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(await snapshot()).toEqual(before);

      const stale = await widen(db.storage, w, { accountId: id, days: "120", apply: true, planHash: "0".repeat(64) });
      expect(stale.code).toBe(1);
      expect(await snapshot()).toEqual(before);

      // The gap changed under the same counts (one thread gone, another arrived): the dry run's hash is stale.
      const saved = w.messages;
      w.messages = [...saved.filter(m => m.threadId !== "o0"), one("o99", T0 - 100 * DAY)];
      const changed = await widen(db.storage, w, { accountId: id, days: "120", apply: true, planHash: String(dry.out.plan_hash) });
      expect(changed.code).toBe(1);
      expect(await snapshot()).toEqual(before);
      w.messages = saved;

      const applied = await widen(db.storage, w, { accountId: id, days: "120", apply: true, planHash: String(dry.out.plan_hash) });
      expect(applied.code).toBe(0);
      expect((await getAccount(e, id))!.config.gmail_history_days).toBe(120);
      expect((await getAccount(e, id))!.config.history_days).toBeUndefined();
      expect(await items(e, id)).toEqual(before.items);

      // The backfill then adds exactly what the dry run counted.
      expect((await run(db.storage, w, id)).status).toBe("success");
      expect((await items(e, id)).length - before.items.length).toBe(25);
    } finally { await db.close(); }
  });

  // Value: protects=an incomplete listing never yields an applicable plan; fails_when=a listing past the page ceiling still applies; why_new=new command; seam=the command with recorded Gmail.
  it("gmail-widen: a listing past the page ceiling is reported truncated and --apply refuses", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const many = Array.from({ length: 205 }, (_, i) => one(`m${i}`, T0 - 95 * DAY - i * 60_000));
      const w = world(many);
      await run(db.storage, w, id);
      w.pageSize = 1;
      const dry = await widen(db.storage, w, { accountId: id, days: "120" });
      expect(dry.code).toBe(0);
      expect(dry.out).toMatchObject({ truncated: true, list_pages: 200 });
      const apply = await widen(db.storage, w, { accountId: id, days: "120", apply: true, planHash: String(dry.out.plan_hash) });
      expect(apply.code).not.toBe(0);
      expect((await getAccount(e, id))!.config.gmail_history_days).toBeUndefined();
    } finally { await db.close(); }
  });

  // Value: protects=a cursor that never kept a floor is not silently "widened"; fails_when=--apply sets the window although no backfill can open; why_new=review finding; seam=the command over a cursor written by the oldest code. Regression proof: red before the no_floor refusal.
  it("gmail-widen: a cursor without a floor is reported, and --apply refuses instead of doing nothing", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world([...RECENT, ...OLD]);
      await run(db.storage, w, id);
      await writeCursor(e, id, GMAIL_STREAM, JSON.stringify({ v: 1, historyId: "120020", historyPage: null, pending: null, floorMs: null, walk: null }), new Date(T0));
      const dry = await widen(db.storage, w, { accountId: id, days: "120" });
      expect(dry.code).toBe(0);
      expect(dry.out).toMatchObject({ cursor_state: "no_floor", threads_in_range: 0 });
      const apply = await widen(db.storage, w, { accountId: id, days: "120", apply: true, planHash: String(dry.out.plan_hash) });
      expect(apply.code).toBe(1);
      expect(String(apply.out.error)).toContain("floor");
      expect((await getAccount(e, id))!.config.gmail_history_days).toBeUndefined();
    } finally { await db.close(); }
  });
});
