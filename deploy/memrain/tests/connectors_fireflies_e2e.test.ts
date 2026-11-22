/**
 * Fireflies end to end, on both engines, against recorded GraphQL answers: an
 * API key saved through the vault connects a disabled account; the first run
 * backfills transcripts as untrusted meeting pages with speaker turns, the
 * summary when there is one, and links to people the brain knows; a later
 * run fetches only what changed; a transcript the provider no longer has is
 * hard-deleted after a probe confirms it, and many at once are held for the
 * owner; a refused key parks the account as needs_reconnect with its cursor
 * kept. No request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { ff, FIREFLIES_KEY, firefliesFetch, type FirefliesRequest, type FirefliesWorld } from "./helpers/fireflies-recorded.ts";
import type { Recorded } from "./github-recorded.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { readExternalTrust } from "../src/core/trust-frame.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, readCredential, setAccountEnabled, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import type { ApiKeyConnectError} from "../src/core/connectors/api-key-connect.ts";
import { connectApiKey } from "../src/core/connectors/api-key-connect.ts";
import { disconnectAccount } from "../src/core/connectors/oauth-connect.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { firefliesProvider, parseTranscriptsCursor, STREAM_RECONCILE, STREAM_TRANSCRIPTS } from "../src/core/connectors/fireflies.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { runConnectorSync, type SyncRunResult } from "../src/core/connectors/sync-engine.ts";
import { readCursor, writeCursor } from "../src/core/connectors/sync-store.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "meet";
const T0 = Date.parse("2025-11-17T12:00:00.000Z");
const HOUR = 3_600_000;
const ENV: NodeJS.ProcessEnv = { MEMRAIN_CONNECTORS_ENABLED: "1", MEMRAIN_DAILY_BUDGET_USD: "5" };

function providers(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.registerApiKey(firefliesProvider());
  return r;
}

const count = async (e: Engine, sql: string, params: unknown[] = []) =>
  Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);

async function rowsContaining(e: Engine, needle: string): Promise<string[]> {
  const tables = (await e.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  const hits: string[] = [];
  for (const { tablename } of tables) {
    if ((await count(e, `SELECT count(*)::int AS n FROM "${tablename}" t WHERE to_jsonb(t)::text LIKE $1`, [`%${needle}%`])) > 0) hits.push(tablename);
  }
  return hits;
}

const listed = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Meeting ${id}`, date: T0 - 5 * HOUR, duration: 10, organizer_email: "owner@example.com",
  participants: ["owner@example.com"], meeting_info: { summary_status: "processed" }, ...over,
});

const transcript = (id: string, sentences: Array<{ speaker_name: string; text: string; start_time?: number }>, over: Record<string, unknown> = {}): Recorded => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: { data: { transcript: {
    ...listed(id), dateString: new Date(T0 - 5 * HOUR).toISOString(), meeting_attendees: [], speakers: [],
    sentences: sentences.map((s, index) => ({ index, raw_text: s.text, start_time: index, ...s })), summary: { overview: "Notes were taken." }, ...over,
  } } },
});

const listing = (items: unknown[]): Recorded => ({ status: 200, headers: { "content-type": "application/json" }, body: { data: { transcripts: items } } });

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`Fireflies connector (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let e: Engine;
  beforeEach(async () => {
    db = await open();
    e = db.storage.engine();
    await registerSource(e, { id: SOURCE, kind: "meeting", pathPrefix: "meeting/" });
  });
  afterEach(async () => { await db.close(); });

  async function connect(fetch: FetchFn): Promise<ConnectorAccount> {
    const { account } = await connectApiKey({ engine: e, kek, providers: providers(), fetch, env: ENV },
      { provider: "fireflies", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" });
    await setAccountEnabled(e, account.id, true);
    return (await getAccount(e, account.id))!;
  }

  async function sync(storage: Storage, accountId: string, fetch: FetchFn, at: number, maxPartBytes?: number): Promise<SyncRunResult> {
    const runtime = connectorRuntime(storage, {
      kek, providers: providers(), fetch, env: ENV, now: () => at, sleep: async () => {},
      embedFn: async (t: string) => deterministicEmbed(t), ...(maxPartBytes ? { maxPartBytes } : {}),
    });
    const account = (await runtime.loadAccount(accountId))!;
    return runConnectorSync(storage, account, runtime.depsFor(account));
  }

  const ops = (requests: FirefliesRequest[]) => requests.map(r => r.operation === "FirefliesTranscript" || r.operation === "FirefliesTranscriptExists"
    ? `${r.operation}:${String(r.variables.id)}` : r.operation);

  const pageOf = async (externalId: string, accountId: string) => (await e.query<{ page_slug: string | null }>(
    `SELECT page_slug FROM connector_items WHERE account_id = $1 AND external_id = $2`, [accountId, externalId])).rows[0]?.page_slug ?? null;

  it("connects with an API key: the key is verified, sealed, and the account starts disabled", async () => {
    const fake = firefliesFetch({ user: () => "user" });
    const { account, reconnected } = await connectApiKey({ engine: e, kek, providers: providers(), fetch: fake.fetch, env: ENV },
      { provider: "fireflies", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" });
    expect(reconnected).toBe(false);
    expect(account).toMatchObject({ provider: "fireflies", account_label: "owner@example.com", enabled: false, status: "active", services: ["fireflies"] });
    expect((await readCredential(e, kek, account.id))?.tokens.access_token).toBe(FIREFLIES_KEY);
    expect(await rowsContaining(e, FIREFLIES_KEY)).toEqual([]);
    expect(ops(fake.requests)).toEqual(["FirefliesUser"]);
  });

  it("refuses a rejected key, a malformed key, a source of the wrong kind and a closed vault", async () => {
    const deps = { engine: e, kek, providers: providers(), env: ENV };
    const rejected = firefliesFetch({ user: () => "user" }, "a-different-key-value");
    const codeOf = async (p: Promise<unknown>) => ((await p.then(() => null, (x: unknown) => x)) as ApiKeyConnectError | null)?.code;
    expect(await codeOf(connectApiKey({ ...deps, fetch: rejected.fetch }, { provider: "fireflies", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" })))
      .toBe("key_rejected");
    const spy = firefliesFetch({ user: () => "user" });
    expect(await codeOf(connectApiKey({ ...deps, fetch: spy.fetch }, { provider: "fireflies", sourceId: SOURCE, apiKey: "short", principalRef: "admin:operator" })))
      .toBe("key_invalid");
    expect(await codeOf(connectApiKey({ ...deps, fetch: spy.fetch }, { provider: "fireflies", sourceId: SOURCE, apiKey: `has space ${FIREFLIES_KEY}`, principalRef: "admin:operator" })))
      .toBe("key_invalid");
    expect(spy.requests).toEqual([]);
    await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
    expect(await codeOf(connectApiKey({ ...deps, fetch: spy.fetch }, { provider: "fireflies", sourceId: "inbox", apiKey: FIREFLIES_KEY, principalRef: "admin:operator" })))
      .toBe("source_kind");
    expect(await codeOf(connectApiKey({ ...deps, fetch: spy.fetch }, { provider: "nope", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" })))
      .toBe("unknown_provider");
    expect(await codeOf(connectApiKey({ ...deps, kek: null, fetch: spy.fetch }, { provider: "fireflies", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" })))
      .toBe("connectors_disabled");
    expect(await count(e, "SELECT count(*)::int AS n FROM connector_accounts")).toBe(0);
  });

  it("backfills, then fetches only what changed, then soft-deletes a transcript the provider no longer has", async () => {
    await putPage(db.storage, { slug: "people/ana-lee", markdown_body: "Ana.", compiled_truth: { aliases: ["ana@example.net"] } });
    let list = "list-initial";
    let ids: string | Recorded = listing([{ id: "ff-t1" }, { id: "ff-t2" }]);
    const fullOf: Record<string, string> = { "ff-t1": "transcript-t1", "ff-t2": "transcript-t2", "ff-t3": "transcript-t3" };
    const world: FirefliesWorld = {
      user: () => "user",
      list: () => list,
      ids: () => ids,
      transcript: (id) => fullOf[id] ?? "not-found",
      exists: () => "not-found",
    };
    const fake = firefliesFetch(world);
    const account = await connect(fake.fetch);
    fake.requests.length = 0;

    const first = await sync(db.storage, account.id, fake.fetch, T0);
    expect(first).toMatchObject({ status: "success", stop_reason: null });
    // ff-t2 has no summary yet and its meeting is under 48 hours old: deferred, not stored half-done.
    expect(first.counts.pages_written).toBe(1);
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscript:ff-t1", "FirefliesTranscript:ff-t2", "FirefliesTranscriptIds"]);
    expect(fake.requests[0]!.variables).toEqual({
      fromDate: new Date(T0 - 90 * 24 * HOUR).toISOString(), toDate: new Date(T0).toISOString(), limit: 50, skip: 0,
    });
    expect(fake.requests.every(r => r.authorization === `Bearer ${FIREFLIES_KEY}`)).toBe(true);
    expect(parseTranscriptsCursor(await readCursor(e, account.id, STREAM_TRANSCRIPTS))).toEqual({
      since: new Date(T0).toISOString(), pending: { "ff-t2": { at: "2025-11-15T13:00:00.000Z", status: "processing", fails: 0 } }, checked: new Date(T0).toISOString(),
    });
    expect(await readCursor(e, account.id, STREAM_RECONCILE)).toBe(new Date(T0).toISOString());

    const t1 = (await pageOf("ff-t1", account.id))!;
    const page = (await e.query<{ markdown_body: string; compiled_truth: Record<string, unknown>; source_id: string }>(
      `SELECT markdown_body, compiled_truth, source_id FROM pages WHERE slug = $1`, [t1])).rows[0]!;
    expect(page.source_id).toBe(SOURCE);
    expect(page.compiled_truth).toMatchObject({ origin: "connector", connector: "fireflies", kind: "meeting", trust: "untrusted", external_id: "ff-t1" });
    expect(page.markdown_body).toContain("Ana Lee (00:00:01): Morning everyone. Let us look at the roadmap.");
    expect(page.markdown_body).toContain("## Summary");
    expect(page.markdown_body).toContain("The team reviewed the roadmap.");
    expect(page.markdown_body).toContain("- Send the notes");
    expect(page.markdown_body).not.toContain("owner@example.com".toUpperCase());
    expect((await readExternalTrust(e, { pages: [t1] })).pages.has(t1)).toBe(true);
    // The instruction-like line is stored as flagged outside text, never acted on.
    expect(await count(e, `SELECT count(*)::int AS n FROM documents WHERE source_id = $1 AND frontmatter->'write_gate' IS NOT NULL`, [SOURCE])).toBe(1);
    // Participants the brain knows become links; strangers only wanted entries.
    const links = (await e.query<{ target_slug: string; type: string }>(`SELECT target_slug, type FROM links WHERE source_slug = $1`, [t1])).rows;
    expect(links).toEqual([{ target_slug: "people/ana-lee", type: "attended" }]);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'people/%'`)).toBe(1);
    expect((await e.query<{ event: string }>(`SELECT event FROM timeline_events WHERE slug = $1`, [t1])).rows.map(r => r.event)).toEqual(["Meeting: Roadmap sync"]);

    expect(await pageOf("ff-t2", account.id)).toBeNull();

    // An hour later: the summary of ff-t2 landed and ff-t3 is new. The deferred
    // ff-t2 is fetched first by id; ff-t1 is not fetched again.
    list = "list-delta";
    fullOf["ff-t2"] = "transcript-t2-summarized";
    fake.requests.length = 0;
    const second = await sync(db.storage, account.id, fake.fetch, T0 + HOUR);
    expect(second.status).toBe("success");
    expect(ops(fake.requests)).toEqual(["FirefliesTranscript:ff-t2", "FirefliesTranscripts", "FirefliesTranscript:ff-t3"]);
    expect(fake.requests[1]!.variables).toMatchObject({ fromDate: new Date(T0 - 48 * HOUR).toISOString(), toDate: new Date(T0 + HOUR).toISOString() });
    const t2 = (await pageOf("ff-t2", account.id))!;
    const t2body = async () => (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [t2])).rows[0]!.markdown_body;
    expect(await t2body()).toContain("The vendor presented an offer.");
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0 + HOUR).toISOString());
    // Nothing changed since: the listing alone answers the next run.
    fake.requests.length = 0;
    expect((await sync(db.storage, account.id, fake.fetch, T0 + 2 * HOUR)).status).toBe("nothing_new");
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts"]);

    // A day later ff-t1 is gone: the listing misses it and the probe confirms.
    list = "list-empty";
    ids = "reconcile-ids";
    fake.requests.length = 0;
    const third = await sync(db.storage, account.id, fake.fetch, T0 + 25 * HOUR);
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscriptIds", "FirefliesTranscriptExists:ff-t1"]);
    expect(third.counts.deletions_applied).toBe(1);
    // Soft-deleted: out of search at once, restorable until the purge removes it for good.
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NOT NULL`, [t1])).toBe(1);
    expect(await count(e, `SELECT count(*)::int AS n FROM documents WHERE source_path LIKE '%' || $1`, [t1])).toBe(0);
    expect((await purgeDeletedPages(e, 0)).slugs).toEqual([t1]);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t1])).toBe(0);
    expect(await rowsContaining(e, "Let us look at the roadmap")).toEqual([]);
    expect(await count(e, `SELECT count(*)::int AS n FROM links WHERE source_slug = $1`, [t1])).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t2])).toBe(1);
    const receipts = (await e.query<{ summary: string }>(`SELECT summary FROM ingest_log WHERE source_type = 'connector-delete'`)).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.summary).not.toContain("Roadmap");
    expect(await readCursor(e, account.id, STREAM_RECONCILE)).toBe(new Date(T0 + 25 * HOUR).toISOString());
  });

  it("links a transcript's people before its cursor moves, so an enrichment that fails is redone next run", async () => {
    await putPage(db.storage, { slug: "people/ana-lee", markdown_body: "Ana.", compiled_truth: { aliases: ["ana@example.net"] } });
    const fake = firefliesFetch({
      user: () => "user",
      list: () => "list-initial",
      ids: () => listing([{ id: "ff-t1" }, { id: "ff-t2" }]),
      transcript: (id) => ({ "ff-t1": "transcript-t1", "ff-t2": "transcript-t2-summarized" })[id] ?? "not-found",
      exists: () => "not-found",
    });
    const account = await connect(fake.fetch);
    let failOnce = true;
    const failing = new Proxy(e, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          if (failOnce && sql.includes("DELETE FROM timeline_events") && sql.includes("source_chunk_id")) {
            failOnce = false;
            throw new Error("connection reset");
          }
          return target.query(sql, params);
        };
      },
    });
    const flaky = new Proxy(db.storage, {
      get(target, prop, receiver) {
        if (prop === "engine") return () => failing;
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(sync(flaky, account.id, fake.fetch, T0)).rejects.toThrow("connection reset");
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBeNull();

    expect((await sync(db.storage, account.id, fake.fetch, T0 + 60_000)).status).toBe("success");
    const t1 = (await pageOf("ff-t1", account.id))!;
    expect((await e.query<{ target_slug: string }>(`SELECT target_slug FROM links WHERE source_slug = $1`, [t1])).rows).toEqual([{ target_slug: "people/ana-lee" }]);
    expect(await count(e, `SELECT count(*)::int AS n FROM timeline_events WHERE slug = $1`, [t1])).toBe(1);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("hard-deletes transcripts past the meeting retention window, and none while the window is off", async () => {
    const fake = firefliesFetch({
      user: () => "user",
      list: () => "list-initial",
      ids: () => listing([{ id: "ff-t1" }, { id: "ff-t2" }]),
      transcript: (id) => ({ "ff-t1": "transcript-t1", "ff-t2": "transcript-t2-summarized" })[id] ?? "not-found",
      exists: () => "not-found",
    });
    const account = await connect(fake.fetch);
    expect((await sync(db.storage, account.id, fake.fetch, T0)).status).toBe("success");
    const t1 = (await pageOf("ff-t1", account.id))!;
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t1])).toBe(1);

    // A year and a day on, with the default 365-day window for meetings.
    const later = T0 + 366 * 24 * HOUR;
    const runtime = connectorRuntime(db.storage, { kek, providers: providers(), fetch: fake.fetch, env: ENV, now: () => later, sleep: async () => {} });
    const loaded = (await runtime.loadAccount(account.id))!;
    // A window set to off keeps everything.
    const kept = connectorRuntime(db.storage, { kek, providers: providers(), fetch: fake.fetch, env: { ...ENV, MEMRAIN_CONNECTOR_RETENTION_DAYS_MEETING: "off" }, now: () => later });
    expect(await kept.depsFor(loaded).sweepRetention!(db.storage)).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t1])).toBe(1);

    expect(await runtime.depsFor(loaded).sweepRetention!(db.storage)).toBe(2);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t1])).toBe(0);
    expect(await rowsContaining(e, "Let us look at the roadmap")).toEqual([]);
    const receipts = (await e.query<{ summary: string }>(`SELECT summary FROM ingest_log WHERE source_type = 'connector-delete'`)).rows;
    expect(receipts.map(r => (JSON.parse(r.summary) as { reason: string }).reason)).toEqual(["retention", "retention"]);
  });

  it("deletes nothing when the listing misses a transcript the provider still has", async () => {
    const fake = firefliesFetch({
      user: () => "user",
      list: () => "list-initial",
      ids: () => listing([]),
      transcript: (id) => id === "ff-t1" ? "transcript-t1" : "transcript-t2-summarized",
      exists: (id) => ({ ...ff("probe-found-t1"), body: { data: { transcript: { id } } } }),
    });
    const account = await connect(fake.fetch);
    const run = await sync(db.storage, account.id, fake.fetch, T0);
    expect(run.status).toBe("success");
    expect(run.counts.deletions_seen).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE])).toBe(2);
  });

  it("re-reads a recent transcript once a day, so an edit with unchanged listing fields still lands", async () => {
    let text = "We agreed on Tuesday.";
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing([listed("ff-edit")]),
      ids: () => listing([{ id: "ff-edit" }]),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text }]),
    });
    const account = await connect(fake.fetch);
    await sync(db.storage, account.id, fake.fetch, T0);
    const slug = (await pageOf("ff-edit", account.id))!;
    const body = async () => (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [slug])).rows[0]!.markdown_body;
    text = "We agreed on Thursday.";
    fake.requests.length = 0;
    await sync(db.storage, account.id, fake.fetch, T0 + 2 * HOUR);
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts"]);
    // Past midnight UTC, still inside the lookback window: fetched again.
    fake.requests.length = 0;
    await sync(db.storage, account.id, fake.fetch, T0 + 14 * HOUR);
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscript:ff-edit"]);
    expect(await body()).toContain("We agreed on Thursday.");
  });

  it("works through more unlisted transcripts than one run may probe instead of re-probing the first ones", async () => {
    const stored = Array.from({ length: 55 }, (_, i) => `ff-p${String(i).padStart(2, "0")}`);
    const goneUpstream = new Set(stored.slice(50));
    let listedNow = true;
    const page = (vars: Record<string, unknown>) => (listedNow ? stored : []).slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit));
    const fake = firefliesFetch({
      user: () => "user",
      list: (vars) => listing(page(vars).map(id => listed(id))),
      ids: (vars) => listing(page(vars).map(id => ({ id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }]),
      exists: (id) => goneUpstream.has(id) ? "not-found" : { ...ff("probe-found-t1"), body: { data: { transcript: { id } } } },
    });
    const account = await connect(fake.fetch);
    expect((await sync(db.storage, account.id, fake.fetch, T0)).counts.pages_written).toBe(55);
    // The listing now misses every transcript, but only the last five are really gone.
    listedNow = false;
    const first = await sync(db.storage, account.id, fake.fetch, T0 + 25 * HOUR);
    expect(first.counts.deletions_seen).toBe(0);
    fake.requests.length = 0;
    const second = await sync(db.storage, account.id, fake.fetch, T0 + 26 * HOUR);
    const probed = fake.requests.filter(r => r.operation === "FirefliesTranscriptExists").map(r => String(r.variables.id));
    expect(probed).toEqual(stored.slice(50));
    expect(second.counts.deletions_applied).toBe(5);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`, [SOURCE])).toBe(50);
    // The cycle is complete: the next reconcile waits a day again.
    fake.requests.length = 0;
    await sync(db.storage, account.id, fake.fetch, T0 + 27 * HOUR);
    expect(fake.requests.map(r => r.operation)).toEqual(["FirefliesTranscripts"]);
  });

  it("fetches only as many transcripts as the run may store, and finishes the window over several runs", async () => {
    // Older than the lookback, so a transcript's version does not change between runs.
    const all = Array.from({ length: 30 }, (_, i) => listed(`ff-cap-${String(i).padStart(2, "0")}`, { date: T0 - 10 * 24 * HOUR - i * HOUR }));
    const fake = firefliesFetch({
      user: () => "user",
      list: (vars) => listing(all.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit))),
      ids: () => listing(all.map(t => ({ id: t.id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }], { date: all.find(t => t.id === id)!.date }),
    });
    const account = await connect(fake.fetch);
    const env = { ...ENV, MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN: "10" };
    const runAt = async (at: number) => {
      const runtime = connectorRuntime(db.storage, {
        kek, providers: providers(), fetch: fake.fetch, env, now: () => at, sleep: async () => {}, embedFn: async (t: string) => deterministicEmbed(t),
      });
      const loaded = (await runtime.loadAccount(account.id))!;
      return runConnectorSync(db.storage, loaded, runtime.depsFor(loaded));
    };
    const fetched = () => fake.requests.filter(r => r.operation === "FirefliesTranscript").length;

    fake.requests.length = 0;
    const first = await runAt(T0);
    expect(first).toMatchObject({ status: "partial", stop_reason: "item_cap_reached" });
    // The 15 the cap would have dropped are never fetched, so no request of the daily quota is wasted.
    expect(fetched()).toBe(10);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBeNull();

    await runAt(T0 + HOUR);
    await runAt(T0 + 2 * HOUR);
    expect(fetched()).toBe(30);
    expect(await count(e, `SELECT count(*)::int AS n FROM connector_items WHERE account_id = $1 AND page_slug IS NOT NULL`, [account.id])).toBe(30);
    // The window's end is committed only once every transcript in it is stored.
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0 + 2 * HOUR).toISOString());
  });

  it("under a daily cap, stores new transcripts before re-reading the recent ones it already has", async () => {
    // All six are recent: each is re-read once a day while it is (see the case above).
    const recent = Array.from({ length: 6 }, (_, i) => listed(`ff-new-${i}`, { date: T0 - 5 * HOUR - i * 60_000 }));
    const fake = firefliesFetch({
      user: () => "user",
      list: (vars) => listing(recent.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit))),
      ids: () => listing(recent.map(t => ({ id: t.id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }], { date: recent.find(t => t.id === id)!.date }),
    });
    const account = await connect(fake.fetch);
    await e.query(`UPDATE connector_accounts SET item_cap_daily = 3 WHERE id = $1`, [account.id]);
    const stored = async () => count(e, `SELECT count(*)::int AS n FROM connector_items WHERE account_id = $1 AND page_slug IS NOT NULL`, [account.id]);

    expect((await sync(db.storage, account.id, fake.fetch, T0)).stop_reason).toBe("item_cap_reached");
    expect(await stored()).toBe(3);
    fake.requests.length = 0;
    // The next UTC day the first three are due a re-read, but the three never stored go first.
    await sync(db.storage, account.id, fake.fetch, T0 + 24 * HOUR);
    expect(await stored()).toBe(6);
    expect(ops(fake.requests).filter(op => op.startsWith("FirefliesTranscript:"))).toEqual(["FirefliesTranscript:ff-new-3", "FirefliesTranscript:ff-new-4", "FirefliesTranscript:ff-new-5"]);
  });

  it("holds a mass deletion for the owner instead of deleting", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `ff-m${i}`);
    let gone = false;
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing(gone ? [] : many.map(id => listed(id))),
      ids: () => listing(gone ? [] : many.map(id => ({ id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }]),
      exists: () => "not-found",
    });
    const account = await connect(fake.fetch);
    expect((await sync(db.storage, account.id, fake.fetch, T0)).counts.pages_written).toBe(12);
    gone = true;
    const run = await sync(db.storage, account.id, fake.fetch, T0 + 25 * HOUR);
    expect(run.counts.deletions_seen).toBe(12);
    expect(run.counts.deletions_held).toBe(12);
    expect(run.counts.deletions_applied).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE])).toBe(12);
    const notices = (await e.query<{ kind: string }>(`SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL`, [account.id])).rows;
    expect(notices.map(n => n.kind)).toEqual(["mass_delete_held"]);
  });

  it("parks the account as needs_reconnect when Fireflies refuses the key, keeping the cursor", async () => {
    let refuse: string | null = null;
    const world: FirefliesWorld = {
      user: () => "user",
      list: () => refuse ?? "list-initial",
      ids: () => listing([{ id: "ff-t1" }, { id: "ff-t2" }]),
      transcript: (id) => id === "ff-t1" ? "transcript-t1" : "transcript-t2-summarized",
    };
    const fake = firefliesFetch(world);
    const account = await connect(fake.fetch);
    await sync(db.storage, account.id, fake.fetch, T0);
    const cursor = await readCursor(e, account.id, STREAM_TRANSCRIPTS);
    expect(cursor).toBe(new Date(T0).toISOString());

    for (const recorded of ["auth-failed", "auth-failed-401"]) {
      refuse = recorded;
      await e.query(`UPDATE connector_accounts SET status = 'active', status_reason = NULL WHERE id = $1`, [account.id]);
      const run = await sync(db.storage, account.id, fake.fetch, T0 + 25 * HOUR);
      expect(run).toMatchObject({ status: "auth_required", stop_reason: "needs_reconnect" });
      expect(JSON.stringify(run)).not.toContain(FIREFLIES_KEY);
      expect((await getAccount(e, account.id))?.status).toBe("needs_reconnect");
      expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(cursor);
    }
    const notices = (await e.query<{ kind: string }>(`SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL`, [account.id])).rows;
    expect(notices.map(n => n.kind)).toEqual(["needs_reconnect"]);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE])).toBe(2);

    // Saving a working key again resumes the account where it stopped.
    refuse = null;
    const again = await connectApiKey({ engine: e, kek, providers: providers(), fetch: fake.fetch, env: ENV },
      { provider: "fireflies", sourceId: SOURCE, apiKey: FIREFLIES_KEY, principalRef: "admin:operator" });
    expect(again.reconnected).toBe(true);
    expect((await getAccount(e, account.id))?.status).toBe("active");
    // ...and answers the reconnect notice at once, without waiting for a clean run.
    expect((await e.query(`SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL`, [account.id])).rows).toEqual([]);
  });

  it("stores a long transcript whole across part pages and keeps the key out of every row", async () => {
    const canary = "quokkacanary4471";
    const sentences = [
      ...Array.from({ length: 200 }, (_, i) => ({ speaker_name: i % 2 ? "Ana Lee" : "Bo Park", text: `Line ${i} about the roadmap and its many details.` })),
      { speaker_name: "Ana Lee", text: `Someone pasted ${FIREFLIES_KEY} here. The code word is ${canary}.` },
    ];
    // The title reaches the chronicle through enrichment, so the key there must be swept too.
    const title = `Standup ${FIREFLIES_KEY}`;
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing([listed("ff-long", { title })]),
      ids: () => listing([{ id: "ff-long" }]),
      transcript: () => transcript("ff-long", sentences, { title }),
    });
    const account = await connect(fake.fetch);
    const run = await sync(db.storage, account.id, fake.fetch, T0, 2048);
    expect(run.status).toBe("success");
    const slug = (await pageOf("ff-long", account.id))!;
    const parts = (await e.query<{ slug: string; markdown_body: string }>(
      `SELECT slug, markdown_body FROM pages WHERE compiled_truth->>'part_of' = $1 ORDER BY slug`, [slug])).rows;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.at(-1)!.markdown_body).toContain(canary);
    expect(await rowsContaining(e, FIREFLIES_KEY)).toEqual([]);
  });

  // Value: protects=a meeting Fireflies is still processing is stored once, whole, with its summary;
  // fails_when=the listing stores a transcript before its summary exists and never fetches it by id again;
  // why_new=no case deferred a transcript before; seam=the real engine and recorded GraphQL shapes.
  it("defers a meeting still processing, then stores it once its summary arrives", async () => {
    let summary: Record<string, unknown> | null = null;
    let status = "processing";
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing([listed("ff-fresh", { date: T0 - HOUR, meeting_info: { summary_status: status } })]),
      ids: () => listing([{ id: "ff-fresh" }]),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: "Kick-off." }],
        { date: T0 - HOUR, dateString: new Date(T0 - HOUR).toISOString(), summary, meeting_info: { summary_status: status } }),
    });
    const account = await connect(fake.fetch);
    const first = await sync(db.storage, account.id, fake.fetch, T0);
    expect(first.counts.pages_written).toBe(0);
    expect(await pageOf("ff-fresh", account.id)).toBeNull();
    expect(parseTranscriptsCursor(await readCursor(e, account.id, STREAM_TRANSCRIPTS))).toEqual({
      since: new Date(T0).toISOString(), pending: { "ff-fresh": { at: new Date(T0 - HOUR).toISOString(), status: "processing", fails: 0 } },
      checked: new Date(T0).toISOString(),
    });

    // While the listing shows the same summary status, the deferred transcript is not
    // fetched again, an hour later or five: each fetch costs quota.
    for (const at of [T0 + 10 * 60_000, T0 + 2 * HOUR, T0 + 5 * HOUR]) {
      fake.requests.length = 0;
      await sync(db.storage, account.id, fake.fetch, at);
      expect(ops(fake.requests)).toEqual(["FirefliesTranscripts"]);
    }
    expect(await pageOf("ff-fresh", account.id)).toBeNull();

    summary = { overview: "The summary arrived." };
    status = "processed";
    fake.requests.length = 0;
    const second = await sync(db.storage, account.id, fake.fetch, T0 + 5 * HOUR + 10 * 60_000);
    expect(second.counts.pages_written).toBe(1);
    // The listing shows the status moved, so it is fetched from there.
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscript:ff-fresh"]);
    const slug = (await pageOf("ff-fresh", account.id))!;
    expect((await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [slug])).rows[0]!.markdown_body)
      .toContain("The summary arrived.");
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0 + 5 * HOUR + 10 * 60_000).toISOString());
  });

  // Value: protects=a deferred transcript whose fetch keeps failing neither blocks the queue nor costs requests
  // forever; fails_when=a failed drain fetch blocks the checkpoint, or the id is never dropped; why_new=review finding;
  // seam=the real engine, a Fireflies internal error recorded in a 200 body.
  it("keeps a failing deferred transcript from blocking the queue, and drops it after three failures", async () => {
    const internalError: Recorded = { status: 200, headers: { "content-type": "application/json" },
      body: { data: null, errors: [{ message: "boom", code: "internal_server_error", extensions: { code: "internal_server_error", status: 500 } }] } };
    let listBad = false;
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing(listBad ? [listed("ff-bad", { date: T0 - 3 * HOUR })] : []),
      ids: () => listing([{ id: "ff-ok" }]),
      transcript: (id) => id === "ff-ok"
        ? transcript(id, [{ speaker_name: "Ana Lee", text: "Fine." }], { date: T0 - 50 * HOUR, dateString: new Date(T0 - 50 * HOUR).toISOString() })
        : internalError,
    });
    const account = await connect(fake.fetch);
    await writeCursor(e, account.id, STREAM_TRANSCRIPTS, JSON.stringify({
      v: 2, since: new Date(T0 - HOUR).toISOString(),
      pending: {
        "ff-bad": { at: new Date(T0 - 3 * HOUR).toISOString(), status: null, fails: 0 },
        "ff-ancient": { at: new Date(T0 - 8 * 24 * HOUR).toISOString(), status: null, fails: 0 },
        "ff-ok": { at: new Date(T0 - 50 * HOUR).toISOString(), status: null, fails: 0 },
      },
    }));
    const pendingNow = async () => parseTranscriptsCursor(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).pending;

    const first = await sync(db.storage, account.id, fake.fetch, T0);
    // ff-ok is stored and leaves the queue; the past-age ff-ancient is dropped at its first failure and held.
    expect(await pageOf("ff-ok", account.id)).not.toBeNull();
    expect(first.counts.items_held).toBe(1);
    expect(await pendingNow()).toEqual({ "ff-bad": { at: new Date(T0 - 3 * HOUR).toISOString(), status: null, fails: 1 } });

    await sync(db.storage, account.id, fake.fetch, T0 + HOUR);
    expect((await pendingNow())["ff-bad"]!.fails).toBe(2);
    const third = await sync(db.storage, account.id, fake.fetch, T0 + 2 * HOUR);
    expect(third.counts.items_held).toBe(1);
    expect(await pendingNow()).toEqual({});
    // Listed again while held, it waits out its hold (the engine's back-off) instead of being fetched every run.
    listBad = true;
    fake.requests.length = 0;
    await sync(db.storage, account.id, fake.fetch, T0 + 2 * HOUR + 30 * 60_000);
    expect(ops(fake.requests)).not.toContain("FirefliesTranscript:ff-bad");
  });

  // Value: protects=a deferred transcript cannot wait forever, and one deleted upstream leaves the queue;
  // fails_when=the seven-day ceiling or the not-found drop is lost; why_new=new queue; seam=cursor written as a run leaves it.
  it("stores a deferred transcript past seven days as it is, and drops one Fireflies no longer has", async () => {
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing([]),
      ids: () => listing([{ id: "ff-old" }]),
      // Its date moved to an hour ago, so only the seven-day ceiling can end the wait.
      transcript: (id) => id === "ff-old" ? transcript(id, [{ speaker_name: "Ana Lee", text: "Still no summary." }], { date: T0 - HOUR, dateString: new Date(T0 - HOUR).toISOString(), summary: null }) : "not-found",
    });
    const account = await connect(fake.fetch);
    await writeCursor(e, account.id, STREAM_TRANSCRIPTS, JSON.stringify({
      v: 2, since: new Date(T0 - HOUR).toISOString(),
      pending: { "ff-old": new Date(T0 - 8 * 24 * HOUR).toISOString(), "ff-gone": new Date(T0 - 2 * HOUR).toISOString() },
    }));
    const run = await sync(db.storage, account.id, fake.fetch, T0);
    expect(run.counts.pages_written).toBe(1);
    expect(await pageOf("ff-old", account.id)).not.toBeNull();
    expect(await pageOf("ff-gone", account.id)).toBeNull();
    expect(ops(fake.requests).slice(-4)).toEqual(["FirefliesTranscript:ff-old", "FirefliesTranscript:ff-gone", "FirefliesTranscripts", "FirefliesTranscriptIds"]);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0).toISOString());
  });

  // Value: protects=one account's deferred transcripts are never fetched with another account's key;
  // fails_when=pending state leaks across accounts; why_new=new queue; seam=two real accounts on two sources.
  it("never hands one account's deferred transcripts to another account", async () => {
    const a = firefliesFetch({
      user: () => "user",
      list: () => listing([listed("ff-proc", { date: T0 - HOUR })]),
      ids: () => listing([]),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: "Processing." }], { date: T0 - HOUR, summary: null }),
    });
    const first = await connect(a.fetch);
    await sync(db.storage, first.id, a.fetch, T0);
    expect(Object.keys(parseTranscriptsCursor(await readCursor(e, first.id, STREAM_TRANSCRIPTS)).pending)).toEqual(["ff-proc"]);

    const otherKey = ["ff", "key", "fedcba9876543210"].join("-");
    const otherUser = ff("user");
    (otherUser.body as { data: { user: { email: string } } }).data.user.email = "other@example.com";
    const b = firefliesFetch({ user: () => otherUser, list: () => listing([]), ids: () => listing([]), transcript: () => "not-found" }, otherKey);
    await registerSource(e, { id: "meet2", kind: "meeting", pathPrefix: "meeting2/" });
    const { account: second } = await connectApiKey({ engine: e, kek, providers: providers(), fetch: b.fetch, env: ENV },
      { provider: "fireflies", sourceId: "meet2", apiKey: otherKey, principalRef: "admin:operator" });
    await setAccountEnabled(e, second.id, true);
    expect(second.id).not.toBe(first.id);
    b.requests.length = 0;
    await sync(db.storage, second.id, b.fetch, T0 + 60_000);
    expect(ops(b.requests)).not.toContain("FirefliesTranscript:ff-proc");
    expect(ops(b.requests)[0]).toBe("FirefliesTranscripts");
  });

  // Value: protects=a listing that never ends stops with a named error instead of walking forever;
  // fails_when=the per-pass page ceiling is lost; why_new=new walk; seam=a listing that ignores skip.
  it("stops an endless listing with listing_unbounded", async () => {
    const all = Array.from({ length: 60 }, (_, i) => listed(`ff-loop-${i}`, { date: T0 - 10 * 24 * HOUR - i * HOUR }));
    const fake = firefliesFetch({
      user: () => "user",
      // Every request answers the first page, whatever its skip.
      list: (vars) => listing(all.slice(0, Number(vars.limit))),
      ids: (vars) => listing(all.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit)).map(t => ({ id: t.id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }], { date: all.find(t => t.id === id)!.date }),
    });
    const account = await connect(fake.fetch);
    const run = await sync(db.storage, account.id, fake.fetch, T0);
    expect(run.stop_reason).toBe("fetch_failed");
    expect(run.error).toContain("listing_unbounded");
    expect(fake.requests.filter(r => r.operation === "FirefliesTranscripts")).toHaveLength(400);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBeNull();
  });

  // Value: protects=an arrival during the walk is still listed in the same run, and the window closes only
  // after a pass adds nothing; fails_when=the walk is a single pass or closes on an unstable pass;
  // why_new=new walk; seam=a listing whose offsets shift after its first page.
  it("walks the window to a fixed point when a transcript arrives mid-listing", async () => {
    const older = Array.from({ length: 60 }, (_, i) => listed(`ff-s-${String(i).padStart(2, "0")}`, { date: T0 - 10 * 24 * HOUR - i * HOUR }));
    let current = older;
    let listCalls = 0;
    const fake = firefliesFetch({
      user: () => "user",
      list: (vars) => {
        const page = current.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit));
        // Newest first: a transcript landing after the first page pushes everything down one place.
        if (++listCalls === 1) current = [listed("ff-s-new", { date: T0 - 9 * 24 * HOUR }), ...older];
        return listing(page);
      },
      ids: (vars) => listing(current.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit)).map(t => ({ id: t.id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }], { date: current.find(t => t.id === id)!.date }),
    });
    const account = await connect(fake.fetch);
    const run = await sync(db.storage, account.id, fake.fetch, T0);
    expect(run.status).toBe("success");
    const fetchedIds = fake.requests.filter(r => r.operation === "FirefliesTranscript").map(r => String(r.variables.id));
    expect(fetchedIds.sort()).toEqual(current.map(t => t.id).sort());
    expect(new Set(fetchedIds).size).toBe(61);
    // Pass 1 missed the arrival, pass 2 found it, pass 3 found nothing new and closed the window.
    expect(listCalls).toBe(6);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0).toISOString());
  });

  // Value: protects=a listing that keeps shifting never closes its window on an incomplete walk;
  // fails_when=the cursor moves after MAX_LISTING_PASSES unstable passes; why_new=new walk; seam=as above.
  it("leaves the window open when the listing keeps changing on every pass", async () => {
    const base = Array.from({ length: 60 }, (_, i) => listed(`ff-u-${String(i).padStart(2, "0")}`, { date: T0 - 10 * 24 * HOUR - i * HOUR }));
    let current = base;
    let arrivals = 0;
    const fake = firefliesFetch({
      user: () => "user",
      list: (vars) => {
        const page = current.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit));
        // A new transcript arrives at the start of every pass.
        if (Number(vars.skip) === 0) current = [listed(`ff-u-new-${++arrivals}`, { date: T0 - 9 * 24 * HOUR + arrivals * HOUR }), ...current];
        return listing(page);
      },
      ids: (vars) => listing(current.slice(Number(vars.skip), Number(vars.skip) + Number(vars.limit)).map(t => ({ id: t.id }))),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: `Notes for ${id}.` }], { date: current.find(t => t.id === id)!.date }),
    });
    const account = await connect(fake.fetch);
    await sync(db.storage, account.id, fake.fetch, T0);
    expect(fake.requests.filter(r => r.operation === "FirefliesTranscripts")).toHaveLength(6);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBeNull();
  });

  // Value: protects=an upgrade keeps the cursor older releases wrote (ISO text) instead of re-reading 90 days;
  // fails_when=the cursor parser accepts only the JSON form; why_new=the cursor gained a second form; seam=a stored legacy cursor.
  it("resumes from a legacy ISO cursor without a 90-day backfill", async () => {
    const fake = firefliesFetch({ user: () => "user", list: () => listing([]), ids: () => listing([]) });
    const account = await connect(fake.fetch);
    const since = new Date(T0 - 6 * HOUR).toISOString();
    await writeCursor(e, account.id, STREAM_TRANSCRIPTS, since);
    fake.requests.length = 0;
    await sync(db.storage, account.id, fake.fetch, T0);
    expect(fake.requests[0]!.variables).toMatchObject({ fromDate: new Date(T0 - 6 * HOUR - 48 * HOUR).toISOString(), toDate: new Date(T0).toISOString() });
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0).toISOString());
  });

  // Value: protects=a stored transcript waiting on Fireflies again is never reported deleted;
  // fails_when=the reconcile probes deferred ids; why_new=new queue; seam=the reconcile stream on the same cursor.
  it("never probes a deferred transcript for deletion", async () => {
    let summary: Record<string, unknown> | null = { overview: "First pass." };
    const fake = firefliesFetch({
      user: () => "user",
      list: () => listing([listed("ff-redo")]),
      ids: () => listing([]),
      transcript: (id) => transcript(id, [{ speaker_name: "Ana Lee", text: "Text." }], { summary }),
      exists: () => "not-found",
    });
    const account = await connect(fake.fetch);
    expect((await sync(db.storage, account.id, fake.fetch, T0)).counts.pages_written).toBe(1);
    // Fireflies is regenerating the summary: the daily re-read finds none and defers it.
    summary = null;
    await sync(db.storage, account.id, fake.fetch, T0 + 14 * HOUR);
    expect(Object.keys(parseTranscriptsCursor(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).pending)).toEqual(["ff-redo"]);
    fake.requests.length = 0;
    const run = await sync(db.storage, account.id, fake.fetch, T0 + 25 * HOUR);
    expect(ops(fake.requests)).not.toContain("FirefliesTranscriptExists:ff-redo");
    expect(run.counts.deletions_seen).toBe(0);
    expect(await pageOf("ff-redo", account.id)).not.toBeNull();
  });

  it("disconnects an API-key account by dropping its sealed key", async () => {
    const fake = firefliesFetch({ user: () => "user" });
    const account = await connect(fake.fetch);
    const out = await disconnectAccount({ engine: e, kek, providers: providers(), fetch: fake.fetch, env: ENV }, account.id);
    expect(out).toEqual({ revoked: false, credentialKept: false });
    expect(await readCredential(e, kek, account.id)).toBeNull();
    expect((await getAccount(e, account.id))).toMatchObject({ status: "revoked", enabled: false });
  });
});
