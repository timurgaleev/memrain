/**
 * The connector sync engine end to end on both engines, driven by a test
 * provider behind the real connector client and a FetchFn: items become
 * pages, per-stream cursors move only past settled items, an item failing
 * three runs is held, a source outage blames nobody, a mass delete waits for
 * the owner, caps stop the run before money or items run out, and a refused
 * credential pauses the account for a reconnect with its cursor kept.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage } from "../src/core/pages.ts";
import * as pageIndex from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { ConnectorClient, type TokenSource } from "../src/core/connectors/client.ts";
import { checkConnectorHealth } from "../src/core/connectors/health.ts";
import {
  runConnectorSync,
  type SyncAccount,
  type SyncAdapter,
  type SyncDeps,
  type SyncItem,
} from "../src/core/connectors/sync-engine.ts";
import {
  confirmHeldDeletes,
  readCursor,
  rejectHeldDeletes,
  retryHeldItems,
  writeCursor,
} from "../src/core/connectors/sync-store.ts";
import { ReauthRequiredError } from "../src/core/connectors/types.ts";
import { acquireWorkerLock } from "../src/core/jobs/worker-lock.ts";
import { logSpend } from "../src/core/budget.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { fakeClock, replay, type Recorded } from "./github-recorded.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const ACCOUNT_ID = "6d2f0c1a-3b4e-4f5a-8b6c-7d8e9f0a1b2c";
const SOURCE = "conn-test";
const STREAM = "items";
// Assembled at run time: a token shape must not sit in the source.
const TOKEN = ["live", "access", "token", "value"].join("-");
const ENV = { MEMRAIN_CONNECTORS_ENABLED: "1" };

type Wire = { id: string; v?: string; title?: string; body?: string; broken?: string; dk?: string };
const wirePage = (items: Wire[], cursor: string | null, more = false, deleted: string[] = []): Recorded => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: { items, deleted, cursor, more },
});

/**
 * The test provider: `GET /v1/items?after=<cursor>` answers a page of items,
 * the ids deleted upstream, the checkpoint after the page and whether more
 * follow. An item with `broken` stands for one the adapter could not read.
 */
const adapter: SyncAdapter = {
  streams: () => [STREAM],
  async page({ client, cursor }) {
    const res = await client.get(`/v1/items${cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`}`);
    if (res.class !== "ok") return { ok: false, response: res };
    const body = res.body as { items: Wire[]; deleted: string[]; cursor: string | null; more: boolean };
    const items: SyncItem[] = body.items.map((w) => w.broken
      ? { externalId: w.id, version: w.v ?? "1", failure: { code: w.broken, message: `cannot read ${w.id}` } }
      : { externalId: w.id, version: w.v ?? "1", slug: `test/acct/${w.id}`, type: "note", title: w.title ?? `Item ${w.id}`, body: w.body ?? `Body of ${w.id}.`, dedupeKey: w.dk ?? null });
    return { ok: true, items, deletions: body.deleted, checkpoint: body.cursor, done: !body.more };
  },
};

function account(over: Partial<SyncAccount> = {}): SyncAccount {
  return { id: ACCOUNT_ID, sourceId: SOURCE, provider: "test", enabled: true, status: "active", itemCapDaily: 5000, spendCapUsdDaily: 1, ...over };
}

interface Harness {
  deps: SyncDeps;
  reconnects: string[];
  deleted: string[];
  tokenCalls: number;
  urls: string[];
}

function harness(responses: Array<Recorded | Error>, opts: { tokenSource?: TokenSource; env?: Record<string, string>; deletes?: boolean } = {}): Harness {
  const clock = fakeClock();
  const fake = replay(responses);
  const h: Harness = { reconnects: [], deleted: [], tokenCalls: 0, urls: fake.urls, deps: undefined as unknown as SyncDeps };
  h.deps = {
    adapter,
    tokenSource: async () => {
      h.tokenCalls++;
      return opts.tokenSource ?? { token: async () => TOKEN, refresh: async () => TOKEN };
    },
    client: (_a, tokenSource) => new ConnectorClient({ origin: ORIGIN, tokenSource, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxRetries: 0, maxWaitMs: 1_000 }),
    accounts: { markNeedsReconnect: async (id) => void h.reconnects.push(id) },
    ...(opts.deletes === false ? {} : { onUpstreamDelete: async (_s: Storage, item: { externalId: string }) => void h.deleted.push(item.externalId) }),
    embedFn: async (t: string) => deterministicEmbed(t),
    env: { ...ENV, ...opts.env },
    holder: "test-worker",
  };
  return h;
}

async function setup(storage: Storage): Promise<void> {
  await registerSource(storage.engine(), { id: SOURCE, kind: "other", pathPrefix: "test/acct/" });
  // Cursors, items and notices reference connector_accounts (migration 152).
  await storage.engine().query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, $2, 'test', 'admin:operator', 'owner@example.test')`,
    [ACCOUNT_ID, SOURCE],
  );
}

/** The percentage rule without its floor, so a handful of deletions on a small account is a mass delete. */
const NO_FLOOR = { env: { MEMRAIN_CONNECTOR_MASS_DELETE_MIN: "1" } };

const itemRow = async (storage: Storage, id: string) => (await storage.engine().query<{ fail_count: number; held_reason: string | null; page_slug: string | null; deleted_upstream_at: string | null }>(
  `SELECT fail_count, held_reason, page_slug, deleted_upstream_at::text AS deleted_upstream_at FROM connector_items WHERE account_id = $1 AND external_id = $2`,
  [ACCOUNT_ID, id])).rows[0];
const openNotices = async (storage: Storage) => (await storage.engine().query<{ kind: string }>(
  `SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL ORDER BY kind`, [ACCOUNT_ID])).rows.map((r) => r.kind);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector sync engine (${name})`, () => {
  it("writes a test provider's items as pages, checkpoints each page, and re-runs for free", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const first = harness([
        wirePage([{ id: "a", body: `Mentions ${TOKEN} by accident.` }, { id: "b" }], "c1", true),
        wirePage([{ id: "c" }], "c2"),
      ]);
      const r = await runConnectorSync(db.storage, account(), first.deps);
      expect(r.status).toBe("success");
      expect(r.counts).toMatchObject({ items: 3, pages_written: 3, items_failed: 0 });
      expect(first.urls).toEqual([`${ORIGIN}/v1/items`, `${ORIGIN}/v1/items?after=c1`]);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c2");
      const a = await getPage(db.storage, "test/acct/a");
      expect(a?.markdown_body).toContain("Mentions");
      expect(a?.markdown_body).not.toContain(TOKEN);
      expect((await itemRow(db.storage, "c"))?.page_slug).toBe("test/acct/c");

      const again = harness([wirePage([{ id: "c" }], "c2")]);
      const r2 = await runConnectorSync(db.storage, account(), again.deps);
      expect(r2.status).toBe("success");
      expect(r2.counts).toMatchObject({ items: 1, pages_written: 0, pages_unchanged: 1 });
      expect(again.urls).toEqual([`${ORIGIN}/v1/items?after=c2`]);
    } finally { await db.close(); }
  });

  it("keeps the cursor at the last settled page when a later page fails", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const h = harness([
        wirePage([{ id: "a" }], "c1", true),
        { status: 429, headers: { "retry-after": "3600" }, body: {} },
      ]);
      const r = await runConnectorSync(db.storage, account(), h.deps);
      expect(r.status).toBe("partial");
      expect(r.error_class).toBe("rate_limited");
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c1");
    } finally { await db.close(); }
  });

  it("holds an item that fails three runs in a row so the cursor can pass it", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const page = () => wirePage([{ id: "ok1" }, { id: "bad", broken: "parse_error" }], "c1");
      for (const run of [1, 2]) {
        const r = await runConnectorSync(db.storage, account(), harness([page()]).deps);
        expect(r.status).toBe("partial");
        expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBeNull();
        expect(Number((await itemRow(db.storage, "bad"))?.fail_count)).toBe(run);
      }
      const third = await runConnectorSync(db.storage, account(), harness([page()]).deps);
      expect(third.counts.items_held).toBe(1);
      expect(third.status).toBe("success");
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c1");
      expect((await itemRow(db.storage, "bad"))?.held_reason).toBe("parse_error");
      expect(await openNotices(db.storage)).toEqual(["items_held"]);
      expect((await checkConnectorHealth(db.storage.engine())).detail).toContain("held");

      // Still inside its back-off: the held item is skipped, not retried.
      const fourth = await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "bad", broken: "parse_error" }], "c2")]).deps);
      expect(fourth.counts.items_skipped_held).toBe(1);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c2");
    } finally { await db.close(); }
  });

  it("treats most items failing the same way as a source outage and counts no item failures", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const items: Wire[] = [
        ...["f1", "f2", "f3", "f4", "f5"].map((id) => ({ id, broken: "upstream_500" })),
        { id: "g1" }, { id: "g2" }, { id: "g3" },
      ];
      const r = await runConnectorSync(db.storage, account(), harness([wirePage(items, "c1")]).deps);
      expect(r.status).toBe("partial");
      expect(r.stop_reason).toBe("source_outage");
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBeNull();
      expect(Number((await itemRow(db.storage, "f1"))?.fail_count ?? 0)).toBe(0);
    } finally { await db.close(); }
  });

  it("holds a mass delete for the owner and applies a small one item by item", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
      await runConnectorSync(db.storage, account(), harness([wirePage(ids.map((id) => ({ id })), "c1")]).deps);

      const small = harness([wirePage([], "c2", false, ["i0"])]);
      const r1 = await runConnectorSync(db.storage, account(), small.deps);
      expect(small.deleted).toEqual(["i0"]);
      expect(r1.counts.deletions_applied).toBe(1);
      expect((await itemRow(db.storage, "i0"))?.deleted_upstream_at).not.toBeNull();

      // 5 of the 29 live items is over 5%: nothing is deleted, the owner is asked.
      const mass = harness([wirePage([], "c3", false, ["i1", "i2", "i3", "i4", "i5"])], NO_FLOOR);
      const r2 = await runConnectorSync(db.storage, account(), mass.deps);
      expect(mass.deleted).toEqual([]);
      expect(r2.counts.deletions_held).toBe(5);
      expect((await itemRow(db.storage, "i1"))?.held_reason).toBe("mass_delete");
      expect(await openNotices(db.storage)).toEqual(["mass_delete_held"]);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c3");
      expect(await getPage(db.storage, "test/acct/i1")).not.toBeNull();
    } finally { await db.close(); }
  });

  it("applies a held mass delete once the owner confirms it, and keeps the pages when the owner refuses", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const ids = Array.from({ length: 10 }, (_, i) => `i${i}`);
      await runConnectorSync(db.storage, account(), harness([wirePage(ids.map((id) => ({ id })), "c1")]).deps);
      await runConnectorSync(db.storage, account(), harness([wirePage([], "c2", false, ["i0", "i1", "i2"])], NO_FLOOR).deps);
      expect((await itemRow(db.storage, "i0"))?.held_reason).toBe("mass_delete");

      expect(await confirmHeldDeletes(db.storage.engine(), ACCOUNT_ID)).toBe(3);
      expect(await openNotices(db.storage)).toEqual([]);
      const confirmed = harness([wirePage([], "c3")]);
      const r = await runConnectorSync(db.storage, account(), confirmed.deps);
      expect(confirmed.deleted).toEqual(["i0", "i1", "i2"]);
      expect(r.counts.deletions_applied).toBe(3);
      expect((await itemRow(db.storage, "i0"))?.held_reason).toBeNull();

      await runConnectorSync(db.storage, account(), harness([wirePage([], "c4", false, ["i3", "i4"])], NO_FLOOR).deps);
      expect(await rejectHeldDeletes(db.storage.engine(), ACCOUNT_ID)).toBe(2);
      expect(await itemRow(db.storage, "i3")).toMatchObject({ held_reason: null, deleted_upstream_at: null });
      const after = harness([wirePage([], "c5")]);
      await runConnectorSync(db.storage, account(), after.deps);
      expect(after.deleted).toEqual([]);
    } finally { await db.close(); }
  });

  it("keeps an upstream deletion pending while no deletion handler is wired", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      await runConnectorSync(db.storage, account(), harness([wirePage(Array.from({ length: 30 }, (_, i) => ({ id: `i${i}` })), "c1")]).deps);
      const unwired = harness([wirePage([], "c2", false, ["i0"])], { deletes: false });
      const r = await runConnectorSync(db.storage, account(), unwired.deps);
      expect(r.counts.deletions_applied).toBe(0);
      expect((await itemRow(db.storage, "i0"))?.held_reason).toBe("delete_pending");

      const wired = harness([wirePage([], "c3")]);
      await runConnectorSync(db.storage, account(), wired.deps);
      expect(wired.deleted).toEqual(["i0"]);
      expect((await itemRow(db.storage, "i0"))?.held_reason).toBeNull();
    } finally { await db.close(); }
  });

  it("never hands over a page another live item still shares", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}` }));
      await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "a", dk: "thread-1" }, { id: "b", dk: "thread-1" }, ...many], "c1")]).deps);
      expect((await itemRow(db.storage, "b"))?.page_slug).toBe("test/acct/a");

      const first = harness([wirePage([], "c2", false, ["a"])]);
      await runConnectorSync(db.storage, account(), first.deps);
      expect(first.deleted).toEqual([]);
      expect((await itemRow(db.storage, "a"))?.held_reason).toBeNull();

      const second = harness([wirePage([], "c3", false, ["b"])]);
      await runConnectorSync(db.storage, account(), second.deps);
      expect(second.deleted).toEqual(["b"]);
    } finally { await db.close(); }
  });

  it("keeps the cursor before a page whose mirror into search failed, and mirrors it on the next run", async () => {
    const db = await open();
    const spy = spyOn(pageIndex, "mirrorPage");
    try {
      await setup(db.storage);
      spy.mockResolvedValueOnce(false);
      const r1 = await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "m" }], "c1")]).deps);
      expect(r1.counts.mirror_failures).toBe(1);
      expect(r1.status).toBe("partial");
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);

      // The cursor did not move, so the provider hands the item back; the
      // page is unchanged by now, and is mirrored anyway.
      const r2 = await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "m" }], "c1")]).deps);
      expect(r2.status).toBe("success");
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c1");
      await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "m" }], "c1")]).deps);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await db.close();
    }
  });

  it("lets only one of two concurrent runs through even when both name the same worker", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const deps = () => harness([wirePage([{ id: "a" }], "c1"), wirePage([{ id: "a" }], "c1")]).deps;
      const [x, y] = await Promise.all([runConnectorSync(db.storage, account(), deps()), runConnectorSync(db.storage, account(), deps())]);
      expect([x.stop_reason, y.stop_reason].filter((s) => s === "locked")).toHaveLength(1);
    } finally { await db.close(); }
  });

  it("lets only one of two concurrent runs of an account in one process through", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const deps = () => {
        const { holder: _holder, ...rest } = harness([wirePage([{ id: "a" }], "c1"), wirePage([{ id: "a" }], "c1")]).deps;
        return rest;
      };
      const [x, y] = await Promise.all([runConnectorSync(db.storage, account(), deps()), runConnectorSync(db.storage, account(), deps())]);
      expect([x.stop_reason, y.stop_reason].filter((s) => s === "locked")).toHaveLength(1);
    } finally { await db.close(); }
  });

  it("updates an item the provider gives no version for when its text changes", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const unversioned = (body: string): SyncAdapter => ({
        streams: () => [STREAM],
        page: async () => ({ ok: true, items: [{ externalId: "u", version: null, slug: "test/acct/u", type: "note", title: "U", body }], checkpoint: "c1", done: true }),
      });
      await runConnectorSync(db.storage, account(), { ...harness([]).deps, adapter: unversioned("First text.") });
      const r = await runConnectorSync(db.storage, account(), { ...harness([]).deps, adapter: unversioned("Second text.") });
      expect(r.counts.pages_written).toBe(1);
      expect((await getPage(db.storage, "test/acct/u"))?.markdown_body).toContain("Second text.");
    } finally { await db.close(); }
  });

  it("stops writing mid-page once another run has taken its lock", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const stolen: SyncAdapter = {
        streams: () => [STREAM],
        page: async () => {
          // Another worker takes the lock over while this run is between heartbeats.
          await db.storage.engine().query(`UPDATE worker_lock SET holder = 'thief' WHERE id = $1`, [`connector-sync:${ACCOUNT_ID}`]);
          return { ok: true, items: [{ externalId: "s", version: "1", slug: "test/acct/s", type: "note", title: "S", body: "Never written." }], checkpoint: "c1", done: true };
        },
      };
      const r = await runConnectorSync(db.storage, account(), { ...harness([]).deps, adapter: stolen });
      expect(r.stop_reason).toBe("lock_lost");
      expect(await getPage(db.storage, "test/acct/s")).toBeNull();
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBeNull();
    } finally { await db.close(); }
  });

  it("lets the owner retry held items before their back-off ends", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const bad = () => wirePage([{ id: "bad", broken: "parse_error" }], "c1");
      for (let i = 0; i < 3; i++) await runConnectorSync(db.storage, account(), harness([bad()]).deps);
      expect((await itemRow(db.storage, "bad"))?.held_reason).toBe("parse_error");
      expect(await retryHeldItems(db.storage.engine(), ACCOUNT_ID)).toBe(1);
      expect(await openNotices(db.storage)).toEqual([]);
      const fixed = await runConnectorSync(db.storage, account(), harness([wirePage([{ id: "bad" }], "c2")]).deps);
      expect(fixed.counts.pages_written).toBe(1);
      expect(await itemRow(db.storage, "bad")).toMatchObject({ held_reason: null, page_slug: "test/acct/bad" });
    } finally { await db.close(); }
  });

  it("pauses the account for a reconnect on a refused refresh, keeps the cursor and tells the owner", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      await writeCursor(db.storage.engine(), ACCOUNT_ID, STREAM, "c9");
      const dead: TokenSource = { token: async () => TOKEN, refresh: async () => { throw new ReauthRequiredError("invalid_grant"); } };
      const h = harness([{ status: 401, headers: {}, body: { error: "invalid_token" } }], { tokenSource: dead });
      const r = await runConnectorSync(db.storage, account(), h.deps);
      expect(r.status).toBe("auth_required");
      expect(r.stop_reason).toBe("needs_reconnect");
      expect(h.reconnects).toEqual([ACCOUNT_ID]);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBe("c9");
      expect(await openNotices(db.storage)).toEqual(["needs_reconnect"]);
      expect((await checkConnectorHealth(db.storage.engine())).detail).toContain("reconnect");

      // The paused account does not run, and its token is not touched.
      const paused = harness([]);
      const skipped = await runConnectorSync(db.storage, account({ status: "needs_reconnect" }), paused.deps);
      expect(skipped.status).toBe("skipped");
      expect(paused.tokenCalls).toBe(0);
    } finally { await db.close(); }
  });

  it("stops at the per-run item cap without passing the unfinished page", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const h = harness([wirePage([{ id: "a" }, { id: "b" }, { id: "c" }], "c1")], { env: { MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "2" } });
      const r = await runConnectorSync(db.storage, account(), h.deps);
      expect(r.status).toBe("partial");
      expect(r.stop_reason).toBe("item_cap_reached");
      expect(r.counts.pages_written).toBe(2);
      expect(await readCursor(db.storage.engine(), ACCOUNT_ID, STREAM)).toBeNull();
    } finally { await db.close(); }
  });

  it("refuses to start once the daily item cap or dollar cap is spent, without touching the credential", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const zero = harness([]);
      const r = await runConnectorSync(db.storage, account({ spendCapUsdDaily: 0 }), zero.deps);
      expect(r).toMatchObject({ status: "partial", stop_reason: "cap_reached" });
      expect(zero.tokenCalls).toBe(0);

      await logSpend(db.storage.engine(), { clientId: `connector:${ACCOUNT_ID}`, operation: "embed", costUsd: 2 });
      const spent = harness([]);
      expect((await runConnectorSync(db.storage, account({ spendCapUsdDaily: 1 }), spent.deps)).stop_reason).toBe("cap_reached");

      await runConnectorSync(db.storage, account({ spendCapUsdDaily: 100 }), harness([wirePage([{ id: "a" }, { id: "b" }], "c1")]).deps);
      const items = harness([]);
      const capped = await runConnectorSync(db.storage, account({ spendCapUsdDaily: 100, itemCapDaily: 2 }), items.deps);
      expect(capped.stop_reason).toBe("item_cap_reached");
      expect(items.tokenCalls).toBe(0);
    } finally { await db.close(); }
  });

  it("does nothing while the global switch is off, the account is disabled, or another run holds it", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const off = harness([], { env: { MEMRAIN_CONNECTORS_ENABLED: "0" } });
      expect((await runConnectorSync(db.storage, account(), off.deps)).stop_reason).toBe("connectors_disabled");
      const disabled = harness([]);
      expect((await runConnectorSync(db.storage, account({ enabled: false }), disabled.deps)).stop_reason).toBe("account_disabled");
      expect(await acquireWorkerLock(db.storage.engine(), `connector-sync:${ACCOUNT_ID}`, "someone-else", 600)).toBe(true);
      const locked = harness([]);
      expect((await runConnectorSync(db.storage, account(), locked.deps)).stop_reason).toBe("locked");
      expect(off.tokenCalls + disabled.tokenCalls + locked.tokenCalls).toBe(0);
    } finally { await db.close(); }
  });

  it("fails closed when the credential cannot be opened (no key), without pausing the account", async () => {
    const db = await open();
    try {
      await setup(db.storage);
      const h = harness([]);
      h.deps = { ...h.deps, tokenSource: async () => { throw new Error("MEMRAIN_CONNECTOR_KEK is not set"); } };
      const r = await runConnectorSync(db.storage, account(), h.deps);
      expect(r).toMatchObject({ status: "partial", stop_reason: "credentials_unavailable" });
      expect(h.reconnects).toEqual([]);
      expect(h.urls).toEqual([]);
    } finally { await db.close(); }
  });
});
