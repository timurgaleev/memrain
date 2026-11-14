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
import { readExternalTrust } from "../src/core/trust-frame.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, readCredential, setAccountEnabled, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import type { ApiKeyConnectError} from "../src/core/connectors/api-key-connect.ts";
import { connectApiKey } from "../src/core/connectors/api-key-connect.ts";
import { disconnectAccount } from "../src/core/connectors/oauth-connect.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { firefliesProvider, STREAM_RECONCILE, STREAM_TRANSCRIPTS } from "../src/core/connectors/fireflies.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { runConnectorSync, type SyncRunResult } from "../src/core/connectors/sync-engine.ts";
import { readCursor } from "../src/core/connectors/sync-store.ts";
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
    sentences: sentences.map((s, index) => ({ index, raw_text: s.text, start_time: index, ...s })), summary: null, ...over,
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

  it("backfills, then fetches only what changed, then hard-deletes a transcript the provider no longer has", async () => {
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
    expect(first.counts.pages_written).toBe(2);
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscript:ff-t1", "FirefliesTranscript:ff-t2", "FirefliesTranscriptIds"]);
    expect(fake.requests[0]!.variables).toEqual({
      fromDate: new Date(T0 - 90 * 24 * HOUR).toISOString(), toDate: new Date(T0).toISOString(), limit: 25, skip: 0,
    });
    expect(fake.requests.every(r => r.authorization === `Bearer ${FIREFLIES_KEY}`)).toBe(true);
    expect(await readCursor(e, account.id, STREAM_TRANSCRIPTS)).toBe(new Date(T0).toISOString());
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

    const t2 = (await pageOf("ff-t2", account.id))!;
    const t2body = async () => (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [t2])).rows[0]!.markdown_body;
    expect(await t2body()).not.toContain("## Summary");

    // An hour later: the summary of ff-t2 landed and ff-t3 is new; ff-t1 is not fetched again.
    list = "list-delta";
    fullOf["ff-t2"] = "transcript-t2-summarized";
    fake.requests.length = 0;
    const second = await sync(db.storage, account.id, fake.fetch, T0 + HOUR);
    expect(second.status).toBe("success");
    expect(ops(fake.requests)).toEqual(["FirefliesTranscripts", "FirefliesTranscript:ff-t2", "FirefliesTranscript:ff-t3"]);
    expect(fake.requests[0]!.variables).toMatchObject({ fromDate: new Date(T0 - 48 * HOUR).toISOString(), toDate: new Date(T0 + HOUR).toISOString() });
    expect(await t2body()).toContain("The vendor presented an offer.");
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
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t1])).toBe(0);
    expect(await rowsContaining(e, "Let us look at the roadmap")).toEqual([]);
    expect(await count(e, `SELECT count(*)::int AS n FROM links WHERE source_slug = $1`, [t1])).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1`, [t2])).toBe(1);
    const receipts = (await e.query<{ summary: string }>(`SELECT summary FROM ingest_log WHERE source_type = 'connector-delete'`)).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.summary).not.toContain("Roadmap");
    expect(await readCursor(e, account.id, STREAM_RECONCILE)).toBe(new Date(T0 + 25 * HOUR).toISOString());
  });

  it("deletes nothing when the listing misses a transcript the provider still has", async () => {
    const fake = firefliesFetch({
      user: () => "user",
      list: () => "list-initial",
      ids: () => listing([]),
      transcript: (id) => id === "ff-t1" ? "transcript-t1" : "transcript-t2",
      exists: (id) => ({ ...ff("probe-found-t1"), body: { data: { transcript: { id } } } }),
    });
    const account = await connect(fake.fetch);
    const run = await sync(db.storage, account.id, fake.fetch, T0);
    expect(run.status).toBe("success");
    expect(run.counts.deletions_seen).toBe(0);
    expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SOURCE])).toBe(2);
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
      transcript: (id) => id === "ff-t1" ? "transcript-t1" : "transcript-t2",
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

  it("disconnects an API-key account by dropping its sealed key", async () => {
    const fake = firefliesFetch({ user: () => "user" });
    const account = await connect(fake.fetch);
    const out = await disconnectAccount({ engine: e, kek, providers: providers(), fetch: fake.fetch, env: ENV }, account.id);
    expect(out).toEqual({ revoked: false, credentialKept: false });
    expect(await readCredential(e, kek, account.id)).toBeNull();
    expect((await getAccount(e, account.id))).toMatchObject({ status: "revoked", enabled: false });
  });
});
