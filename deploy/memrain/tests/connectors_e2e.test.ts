/**
 * The connector lanes wired together, on both engines: a test provider is
 * connected through the OAuth flow, the scheduler queues `connector_sync` for
 * its source, the job syncs a meeting whose transcript is split into parts and
 * stored as untrusted outside text, and the provider's deletion removes the
 * page, its parts, chunks, embeddings and facts with a text-free receipt. A
 * refresh token the provider refuses parks the account as `needs_reconnect`
 * and leaves its cursor where it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fakeProvider, TEST_ACCESS_TOKEN, testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { readExternalTrust } from "../src/core/trust-frame.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { completeConnect, connectorCallbackUri, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { ProviderRegistry, type ConnectorProvider } from "../src/core/connectors/providers.ts";
import { renderMeeting } from "../src/core/connectors/render.ts";
import { readCursor } from "../src/core/connectors/sync-store.ts";
import type { SyncAdapter } from "../src/core/connectors/sync-engine.ts";
import type { MeetingTranscript } from "../src/core/connectors/model.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import { connectorRuntime, syncItemFromPage } from "../src/core/connectors/runtime.ts";
import { registerConnectorSync } from "../src/core/connectors/sync-job.ts";
import { CONNECTOR_SYNC_JOB_KIND } from "../src/core/jobs/kinds.ts";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { enqueueDueDaemons } from "../src/core/daemons/scheduler.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

const kek = kekFromBytes(randomBytes(32));
const SESSION = `admin-session-id-${"c".repeat(24)}`;
const API = "https://api.provider.test";
const SOURCE = "meet";
const CANARY = "quokkacanary8812";
const MEETING_ID = "mtg-1";
const T0 = new Date("2026-11-16T10:07:00Z");
const WINDOW_MS = 15 * 60_000;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_DAEMONS: "1",
  MEMRAIN_DAILY_BUDGET_USD: "5",
  MEMRAIN_TEST_OAUTH_CLIENT_ID: "env-client-id",
  MEMRAIN_TEST_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};

/** What the fake provider answers right now. */
interface World {
  meetings: MeetingTranscript[];
  deleted: string[];
  cursor: string;
  refuseRefresh: boolean;
  apiCalls: number;
}

const meeting = (): MeetingTranscript => ({
  id: MEETING_ID,
  title: "Quarterly planning",
  start: "2026-11-15T09:00:00.000Z",
  end: "2026-11-15T10:00:00.000Z",
  participants: [{ name: "Ana Lee", email: "ana@example.net" }],
  summary: "We planned the quarter.",
  actionItems: ["Send the notes"],
  // Long enough to need several parts at the test's part size; the canary
  // sits in the last line, so it only survives if nothing is cut.
  sentences: [
    ...Array.from({ length: 120 }, (_, i) => ({ speaker: "Ana Lee", text: `Line ${i} of a long discussion about the roadmap and its many details.` })),
    { speaker: "Ana Lee", text: `The code word is ${CANARY}.` },
  ],
});

/** The provider's own adapter: meetings rendered by the shared renderer. */
function meetingAdapter(accountLabel: string): SyncAdapter {
  return {
    streams: () => ["meetings"],
    async page({ client, cursor }) {
      const res = await client.get(`/v1/meetings${cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`}`);
      if (res.class !== "ok") return { ok: false, response: res };
      const body = res.body as { meetings: MeetingTranscript[]; deleted: string[]; cursor: string };
      const items = body.meetings.map(m => syncItemFromPage(renderMeeting({ service: "fireflies", accountLabel }, m), "v1"));
      return { ok: true, items, deletions: body.deleted, checkpoint: body.cursor, done: true };
    },
  };
}

function provider(): ConnectorProvider {
  return {
    ...testProvider("test"),
    services: { meetings: { scopes: ["meetings.read"], sourceKinds: ["meeting"] } },
    sync: { apiOrigin: API, adapter: account => meetingAdapter(account.accountLabel ?? "") },
  };
}

function providerFetch(world: World): FetchFn {
  const auth = fakeProvider({ grantedScope: "openid meetings.read" });
  return async (url, init) => {
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    if (url === "https://auth.provider.test/token" && body?.get("grant_type") === "refresh_token" && world.refuseRefresh) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.startsWith(`${API}/v1/meetings`)) {
      world.apiCalls++;
      if (new Headers(init.headers).get("authorization") !== `Bearer ${TEST_ACCESS_TOKEN}`) return new Response("no", { status: 401 });
      return Response.json({ meetings: world.meetings, deleted: world.deleted, cursor: world.cursor });
    }
    return auth.fetch(url, init);
  };
}

const count = async (e: Engine, sql: string, params: unknown[] = []) =>
  Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);

/** Every public table holding the needle anywhere in a row. */
async function rowsContaining(e: Engine, needle: string): Promise<string[]> {
  const tables = (await e.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  const hits: string[] = [];
  for (const { tablename } of tables) {
    if ((await count(e, `SELECT count(*)::int AS n FROM "${tablename}" t WHERE to_jsonb(t)::text LIKE $1`, [`%${needle}%`])) > 0) hits.push(tablename);
  }
  return hits;
}

beforeEach(() => _resetHandlersForTesting());
afterEach(() => _resetHandlersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connectors end to end (${name})`, () => {
  /** Connect the test provider through OAuth and enable the account and the daemon. */
  async function connect(storage: Storage, world: World) {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "meeting", pathPrefix: "meeting/" });
    const providers = new ProviderRegistry();
    providers.register(provider());
    const fetch = providerFetch(world);
    const deps: ConnectDeps = { engine: e, kek, providers, fetch, env: ENV };
    const started = await startConnect(deps, {
      provider: "test", sourceId: SOURCE, services: ["meetings"], principalRef: "admin:operator", adminSessionId: SESSION,
      redirectUri: connectorCallbackUri("https://brain.example.test", "test"),
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const { account } = await completeConnect(deps, { provider: "test", state, code: "auth-code-1", adminSessionId: SESSION });
    await setAccountEnabled(e, account.id, true);
    await e.query(`INSERT INTO daemon_controls (daemon, source_id, enabled) VALUES ('connector_sync', '*', true)`);
    registerConnectorSync(storage, connectorRuntime(storage, {
      kek, providers, fetch, env: ENV, embedFn: async (t: string) => deterministicEmbed(t), maxPartBytes: 2048, now: () => T0.getTime(),
    }));
    return account;
  }

  /** One scheduler tick at `at`, then the worker runs what it queued. */
  async function tick(storage: Storage, at: Date) {
    const e = storage.engine();
    const queued = (await enqueueDueDaemons(e, at, { env: ENV })).filter(r => r.daemon === "connector_sync");
    const queue = new Queue(e);
    const results: Array<Record<string, unknown>> = [];
    for (let job = await queue.claim({ now: at, kinds: [CONNECTOR_SYNC_JOB_KIND] }); job; job = await queue.claim({ now: at, kinds: [CONNECTOR_SYNC_JOB_KIND] })) {
      const out = (await getHandler(CONNECTOR_SYNC_JOB_KIND)!(job.payload, { job })) ?? {};
      await queue.complete(job.id, job.claimGeneration, out);
      results.push(out);
    }
    return { queued, results };
  }

  it("syncs a connected account on schedule and hard-deletes what the provider deleted", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const world: World = { meetings: [meeting()], deleted: [], cursor: "c1", refuseRefresh: false, apiCalls: 0 };
      const account = await connect(db.storage, world);
      await putPage(db.storage, { slug: "people/ana-lee", markdown_body: "Ana.", compiled_truth: { aliases: ["ana@example.net"] } });

      const first = await tick(db.storage, T0);
      expect(first.queued.map(q => [q.sourceId, q.outcome])).toEqual([[SOURCE, "queued"]]);
      expect(first.results).toHaveLength(1);
      expect((first.results[0]!.accounts as Array<{ status: string }>)[0]!.status).toBe("success");
      expect(JSON.stringify(first.results)).not.toContain(TEST_ACCESS_TOKEN);

      const slug = renderMeeting({ service: "fireflies", accountLabel: account.account_label }, meeting()).slug;
      const parent = (await e.query<{ markdown_body: string; compiled_truth: Record<string, unknown> }>(
        `SELECT markdown_body, compiled_truth FROM pages WHERE slug = $1 AND source_id = $2`, [slug, SOURCE])).rows[0]!;
      expect(parent.compiled_truth).toMatchObject({ origin: "connector", trust: "untrusted" });
      expect((await readExternalTrust(e, { pages: [slug] })).pages.has(slug)).toBe(true);
      const parts = (await e.query<{ slug: string; markdown_body: string }>(
        `SELECT slug, markdown_body FROM pages WHERE compiled_truth->>'part_of' = $1 ORDER BY slug`, [slug])).rows;
      expect(parts.length).toBeGreaterThan(1);
      expect(parent.markdown_body).toContain(`[[${parts[0]!.slug}]]`);
      expect(parts.at(-1)!.markdown_body).toContain(CANARY);
      expect(parts.map(p => p.markdown_body).join("")).not.toContain("transcript truncated");
      expect(await readCursor(e, account.id, "meetings")).toBe("c1");

      const docs = `SELECT d.id FROM documents d WHERE d.source_id = '${SOURCE}'`;
      expect(await count(e, `SELECT count(*)::int AS n FROM chunks WHERE document_id IN (${docs})`)).toBeGreaterThan(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${docs}))`)).toBeGreaterThan(0);
      await addFact(db.storage, { entity_slug: "people/ana-lee", fact: `Ana said ${CANARY}`, source_slug: parts.at(-1)!.slug, source_id: SOURCE });
      await addFact(db.storage, { entity_slug: "people/ana-lee", fact: `Ana planned ${CANARY}`, source_slug: slug, source_id: SOURCE });
      expect((await rowsContaining(e, CANARY)).length).toBeGreaterThan(0);

      // The same window again queues nothing: one run per window.
      expect((await tick(db.storage, new Date(T0.getTime() + 60_000))).results).toHaveLength(0);

      world.meetings = [];
      world.deleted = [MEETING_ID];
      world.cursor = "c2";
      const second = await tick(db.storage, new Date(T0.getTime() + WINDOW_MS));
      const run = (second.results[0]!.accounts as Array<{ status: string; counts: { deletions_applied: number } }>)[0]!;
      expect(run.counts.deletions_applied).toBe(1);

      expect(await rowsContaining(e, CANARY)).toEqual([]);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 OR compiled_truth->>'part_of' = $1`, [slug])).toBe(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM documents WHERE source_id = '${SOURCE}'`)).toBe(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM entity_facts WHERE source_id = '${SOURCE}'`)).toBe(0);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/ana-lee'`)).toBe(1);
      const receipts = (await e.query<{ summary: string }>(`SELECT summary FROM ingest_log WHERE source_type = 'connector-delete'`)).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.summary).not.toContain(slug);
      expect(await readCursor(e, account.id, "meetings")).toBe("c2");
    } finally { await db.close(); }
  });

  it("parks the account as needs_reconnect when the provider refuses the refresh, keeping its cursor", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const world: World = { meetings: [meeting()], deleted: [], cursor: "c1", refuseRefresh: false, apiCalls: 0 };
      const account = await connect(db.storage, world);
      await tick(db.storage, T0);
      expect(await readCursor(e, account.id, "meetings")).toBe("c1");

      // The access token has expired and the provider will not renew it.
      await storeCredential(e, kek, account, { access_token: "expired-access-token-0000", refresh_token: "revoked-refresh-token-0000" },
        { scopes: ["openid", "meetings.read"], expiresAt: new Date(Date.now() - 3_600_000) });
      world.refuseRefresh = true;
      world.cursor = "c2";
      const calls = world.apiCalls;
      const out = await tick(db.storage, new Date(T0.getTime() + WINDOW_MS));
      const run = (out.results[0]!.accounts as Array<{ status: string; stop_reason: string }>)[0]!;
      expect(run).toMatchObject({ status: "auth_required", stop_reason: "needs_reconnect" });
      expect(world.apiCalls).toBe(calls);

      expect((await getAccount(e, account.id))?.status).toBe("needs_reconnect");
      expect(await readCursor(e, account.id, "meetings")).toBe("c1");
      const notices = (await e.query<{ kind: string }>(`SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL`, [account.id])).rows;
      expect(notices.map(n => n.kind)).toEqual(["needs_reconnect"]);
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE source_id = '${SOURCE}'`)).toBeGreaterThan(0);

      // A paused account gives the scheduler nothing to queue.
      expect((await tick(db.storage, new Date(T0.getTime() + 2 * WINDOW_MS))).queued).toEqual([]);
    } finally { await db.close(); }
  });
});
