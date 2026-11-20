/**
 * The Slack connector against a fake workspace (tests/helpers/slack-fake.ts),
 * on both engines: connecting with the OAuth v2 flow or a pasted internal-app
 * bot token, and syncing an explicit channel allowlist as one page per channel
 * per UTC day. An unchanged day costs one history read and no reply reads; an
 * edit inside the lookback rebuilds its day; a channel taken off the
 * allowlist is no longer read and keeps its pages; a rate limit past the
 * client's wait ends the run partial with the cursor where it was; a channel
 * the bot was not invited to is held without stopping the others.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { SLACK_BOT_TOKEN, SLACK_PUBLIC_SCOPE, SLACK_TEAM, slackCalls, slackFetch, slackTs, type SlackWorld } from "./helpers/slack-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, readCredential, setAccountConfig, setAccountEnabled, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import { ApiKeyConnectError, connectApiKey } from "../src/core/connectors/api-key-connect.ts";
import { setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { completeConnect, ConnectError, connectorCallbackUri, disconnectAccount, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { builtinProviders, ProviderRegistry } from "../src/core/connectors/providers.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { heldItemCount, readCursor } from "../src/core/connectors/sync-store.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import { accountRef, shortHash, PASTED_TOKEN } from "../src/core/connectors/model.ts";
import { SLACK_PRIVATE_SCOPES, SLACK_PUBLIC_SCOPES, slackProvider } from "../src/core/connectors/slack/provider.ts";
import { slackStream } from "../src/core/connectors/slack/adapter.ts";
import { slackText } from "../src/core/connectors/slack/text.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(30_000);

const kek = kekFromBytes(randomBytes(32));
const SESSION = `admin-session-id-${"s".repeat(24)}`;
const SOURCE = "team-chat";
const T0 = Date.parse("2026-11-16T12:00:00.000Z");
const HOUR = 3_600_000;
const ENV: NodeJS.ProcessEnv = { MEMRAIN_CONNECTORS_ENABLED: "1", MEMRAIN_DAILY_BUDGET_USD: "5" };
const GENERAL = "C0GENERAL1";
const RANDOM = "C0RANDOM01";
const SECRET = "G0SECRET01";

function providers(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(slackProvider());
  return r;
}

/** A small workspace: a thread on the 14th, a message on the 15th, lunch talk in #random. */
function world(): SlackWorld {
  const thread = slackTs("2026-11-14T10:00:00Z", 1);
  return {
    channels: { [GENERAL]: { name: "general" }, [RANDOM]: { name: "random" } },
    messages: {
      [GENERAL]: [
        { ts: thread, user: "U0ANA00001", text: "Ship it, <@U0BEN00001>?", reply_count: 1, latest_reply: slackTs("2026-11-14T10:05:00Z", 2) },
        { ts: slackTs("2026-11-14T10:01:00Z", 3), user: "U0BEN00001", subtype: "channel_join", text: "<@U0BEN00001> has joined the channel" },
        { ts: slackTs("2026-11-15T09:00:00Z", 4), user: "U0BEN00001", text: "Deploy done &amp; verified" },
      ],
      [RANDOM]: [{ ts: slackTs("2026-11-15T11:00:00Z", 5), user: "U0ANA00001", text: "lunch?" }],
    },
    replies: { [`${GENERAL}:${thread}`]: [{ ts: slackTs("2026-11-14T10:05:00Z", 2), user: "U0BEN00001", text: "yes", thread_ts: thread }] },
    users: { U0ANA00001: { name: "ana", real_name: "Ana Lee" }, U0BEN00001: { name: "ben", real_name: "Ben Okafor" } },
    calls: [],
  };
}

describe("slack provider", () => {
  it("ships in the built-in registry with read-only bot scopes and Slack's OAuth v2 endpoints", () => {
    const slack = builtinProviders().get("slack");
    expect(slack).not.toBeNull();
    expect(slack!.authorizeUrl).toBe("https://slack.com/oauth/v2/authorize");
    expect(slack!.tokenUrl).toBe("https://slack.com/api/oauth.v2.access");
    expect(slack!.scopeSeparator).toBe(",");
    expect(slack!.baseScopes).toEqual([]);
    expect(slack!.services.slack!.scopes).toEqual([...SLACK_PUBLIC_SCOPES]);
    expect(slack!.services.slack!.sourceKinds).toEqual(["chat"]);
    expect(slack!.services.slack_private!.scopes).toEqual([...SLACK_PRIVATE_SCOPES]);
    expect(slack!.sync?.apiOrigin).toBe("https://slack.com");
    for (const s of Object.values(slack!.services).flatMap(v => v.scopes)) expect(s).toMatch(/:(history|read)$/);
  });

  it("turns Slack mrkdwn into plain text: mentions by name, channels, links and escapes", () => {
    const names: Record<string, string> = { U0ANA00001: "Ana Lee" };
    const name = (id: string) => names[id] ?? id;
    expect(slackText("Hi <@U0ANA00001>, see <#C0GENERAL1|general>", name)).toBe("Hi @Ana Lee, see #general");
    expect(slackText("<https://example.com/doc|the doc> and <https://example.com/x>", name)).toBe("the doc (https://example.com/doc) and https://example.com/x");
    expect(slackText("<!here> 1 &lt; 2 &amp;&amp; 3 &gt; 2", name)).toBe("@here 1 < 2 && 3 > 2");
    expect(slackText("<mailto:ana@example.com|ana@example.com>", name)).toBe("ana@example.com");
    expect(slackText("<@U0NOBODY1>", name)).toBe("@U0NOBODY1");
  });

  it("names a stream after the channel id", () => {
    expect(slackStream(GENERAL)).toBe(`slack:${GENERAL}`);
  });
});

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

const count = async (e: Engine, sql: string, params: unknown[] = []) =>
  Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);

const daySlug = (channel: string, day: string) => `chat/${accountRef(SLACK_TEAM.name, "slack")}/${shortHash(`channel:${channel}`)}/${day}`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`slack connector (${name})`, () => {
  async function pasteToken(storage: Storage, w: SlackWorld, channels: string[] = [GENERAL, RANDOM]): Promise<ConnectorAccount> {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
    const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: slackFetch(w), env: ENV, now: () => T0 };
    const { account } = await connectApiKey(deps, { provider: "slack", sourceId: SOURCE, apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" });
    await setAccountConfig(e, account.id, { channels, history_days: 5 });
    await setAccountEnabled(e, account.id, true);
    return (await getAccount(e, account.id))!;
  }

  async function run(storage: Storage, w: SlackWorld, accountId: string, at: number = T0) {
    const rt = connectorRuntime(storage, {
      kek, providers: providers(), fetch: slackFetch(w), env: ENV, now: () => at, sleep: async () => {},
      embedFn: async (t: string) => deterministicEmbed(t),
    });
    const account = (await rt.loadAccount(accountId))!;
    return runConnectorSync(storage, account, rt.depsFor(account));
  }

  const body = async (e: Engine, slug: string) =>
    (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [slug])).rows[0]?.markdown_body ?? null;

  it("connects over OAuth v2 with comma-separated read-only scopes and leaves the account off", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
      await setOAuthClient(e, kek, "slack", "111.222", "byo-slack-client-secret");
      const w = world();
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: slackFetch(w), env: {}, now: () => T0 };
      const started = await startConnect(deps, {
        provider: "slack", sourceId: SOURCE, services: ["slack"], principalRef: "admin:operator", adminSessionId: SESSION,
        redirectUri: connectorCallbackUri("https://brain.example.test", "slack"),
      });
      const url = new URL(started.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect(url.searchParams.get("scope")).toBe(SLACK_PUBLIC_SCOPE);
      expect(url.searchParams.get("redirect_uri")).toBe("https://brain.example.test/admin/connectors/callback/slack");
      // Slack refuses PKCE from an app that did not opt into it, and the app holds a client secret.
      expect(url.searchParams.has("code_challenge")).toBe(false);
      expect(url.searchParams.has("code_challenge_method")).toBe(false);
      const { account } = await completeConnect(deps, { provider: "slack", state: url.searchParams.get("state"), code: "fake-slack-code", adminSessionId: SESSION });
      expect(account.account_label).toBe(SLACK_TEAM.name);
      expect(account.services).toEqual(["slack"]);
      expect(account.enabled).toBe(false);
      expect(account.config["provider_user_id"]).toBe(SLACK_TEAM.id);
      expect(account.config[PASTED_TOKEN]).toBeUndefined();
      const exchange = slackCalls(w, "oauth.v2.access")[0]!;
      expect(exchange.get("client_id")).toBe("111.222");
      expect(exchange.get("client_secret")).toBe("byo-slack-client-secret");
      expect(exchange.has("code_verifier")).toBe(false);
    } finally { await db.close(); }
  });

  it("refuses and revokes a grant that can write to Slack", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
      await setOAuthClient(e, kek, "slack", "111.222", "byo-slack-client-secret");
      const w = { ...world(), scope: `${SLACK_PUBLIC_SCOPE},chat:write` };
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: slackFetch(w), env: {}, now: () => T0 };
      const started = await startConnect(deps, {
        provider: "slack", sourceId: SOURCE, services: ["slack"], principalRef: "admin:operator", adminSessionId: SESSION,
        redirectUri: connectorCallbackUri("https://brain.example.test", "slack"),
      });
      const state = new URL(started.authorizeUrl).searchParams.get("state");
      const err = await completeConnect(deps, { provider: "slack", state, code: "fake-slack-code", adminSessionId: SESSION }).catch(x => x);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("scope_mismatch");
      expect(slackCalls(w, "auth.revoke")).toHaveLength(1);
      expect(await count(e, "SELECT count(*)::int AS n FROM connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  /** An OAuth connect into `sourceId` through Slack's fake: started, then called back with a code. */
  async function oauthConnect(deps: ConnectDeps, sourceId: string = SOURCE) {
    await setOAuthClient(deps.engine, kek, "slack", "111.222", "byo-slack-client-secret");
    const started = await startConnect(deps, {
      provider: "slack", sourceId, services: ["slack"], principalRef: "admin:operator", adminSessionId: SESSION,
      redirectUri: connectorCallbackUri("https://brain.example.test", "slack"),
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    return completeConnect(deps, { provider: "slack", state, code: "fake-slack-code", adminSessionId: SESSION });
  }

  it("refuses a widened grant for a workspace a live account syncs without revoking the token they share", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      await pasteToken(db.storage, w);
      // Slack adds scopes on a reinstall and hands back the workspace's one bot token: revoking it would cut off the live account.
      const wide = { ...w, scope: `${SLACK_PUBLIC_SCOPE},chat:write` };
      const err = await oauthConnect({ engine: e, kek, providers: providers(), fetch: slackFetch(wide), env: {}, now: () => T0 }).catch(x => x);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("scope_mismatch_not_revoked");
      expect(slackCalls(wide, "auth.revoke")).toHaveLength(0);
    } finally { await db.close(); }
  });

  it("takes a pasted bot token: checks it with Slack, refuses user tokens and write scopes", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
      const deps = (w: SlackWorld): ConnectDeps => ({ engine: e, kek, providers: providers(), fetch: slackFetch(w), env: ENV, now: () => T0 });
      const userToken = ["xoxp", "fake", "user", "token", "value"].join("-");
      const bad = await connectApiKey(deps(world()), { provider: "slack", sourceId: SOURCE, apiKey: userToken, principalRef: "admin:operator" }).catch(x => x);
      expect(bad).toBeInstanceOf(ApiKeyConnectError);
      expect((bad as ApiKeyConnectError).code).toBe("key_invalid");

      const writer = { ...world(), scope: `${SLACK_PUBLIC_SCOPE},chat:write` };
      const wide = await connectApiKey(deps(writer), { provider: "slack", sourceId: SOURCE, apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" }).catch(x => x);
      expect(wide).toBeInstanceOf(ApiKeyConnectError);
      expect((wide as ApiKeyConnectError).code).toBe("scope_mismatch");
      expect(await count(e, "SELECT count(*)::int AS n FROM connector_accounts")).toBe(0);

      const priv = { ...world(), scope: `${SLACK_PUBLIC_SCOPE},groups:history,groups:read` };
      const { account } = await connectApiKey(deps(priv), { provider: "slack", sourceId: SOURCE, apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" });
      expect(account.account_label).toBe(SLACK_TEAM.name);
      expect([...account.services].sort()).toEqual(["slack", "slack_private"]);
      expect(account.enabled).toBe(false);
      expect(account.config[PASTED_TOKEN]).toBe(true);
      expect((await readCredential(e, kek, account.id))!.tokens.access_token).toBe(SLACK_BOT_TOKEN);
    } finally { await db.close(); }
  });

  it("writes one page per channel day, then an unchanged day costs one history read and no reply reads", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      w.calls.length = 0;

      const first = await run(db.storage, w, account.id);
      expect(first.status).toBe("success");
      expect(first.counts.pages_written).toBe(3);
      const thread = (await body(e, daySlug(GENERAL, "2026-11-14")))!;
      expect(thread).toContain("Ship it, @Ben Okafor?");
      expect(thread).toContain("yes");
      expect(thread).not.toContain("has joined the channel");
      expect(await body(e, daySlug(GENERAL, "2026-11-15"))).toContain("Deploy done & verified");
      expect(await body(e, daySlug(RANDOM, "2026-11-15"))).toContain("lunch?");
      // Five days per channel on the first sync, one history read each.
      expect(slackCalls(w, "conversations.history")).toHaveLength(10);
      expect(slackCalls(w, "conversations.replies")).toHaveLength(1);
      expect(JSON.parse((await readCursor(e, account.id, slackStream(GENERAL)))!)).toEqual({ v: 1, through: "2026-11-16" });
      const truth = (await e.query<{ compiled_truth: Record<string, unknown>; type: string }>(
        `SELECT compiled_truth, type FROM pages WHERE slug = $1`, [daySlug(GENERAL, "2026-11-14")])).rows[0]!;
      expect(truth.type).toBe("connector-chat");
      expect(truth.compiled_truth).toMatchObject({ origin: "connector", trust: "untrusted", connector: "slack" });

      w.calls.length = 0;
      const second = await run(db.storage, w, account.id, T0 + HOUR);
      expect(second.status).toBe("nothing_new");
      expect(second.counts.pages_written).toBe(0);
      // The lookback re-reads the last three days and today, once each, and no thread.
      const days = slackCalls(w, "conversations.history").filter(q => q.get("channel") === GENERAL).map(q => q.get("oldest"));
      expect(days).toHaveLength(4);
      expect(new Set(days).size).toBe(4);
      expect(slackCalls(w, "conversations.replies")).toHaveLength(0);
      expect(slackCalls(w, "users.info")).toHaveLength(0);
    } finally { await db.close(); }
  });

  it("stores a day longer than the listing cap with its newest messages and moves the cursor past it", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      // One message a page: 30 on the 14th is more pages than one listing walks.
      w.historyPageSize = 1;
      w.messages[RANDOM] = Array.from({ length: 30 }, (_, i) => ({
        ts: slackTs(`2026-11-14T08:${String(i).padStart(2, "0")}:00Z`, 100 + i), user: "U0ANA00001", text: `msg-${String(i + 1).padStart(2, "0")}`,
      }));
      const account = await pasteToken(db.storage, w, [RANDOM]);

      const result = await run(db.storage, w, account.id);
      expect(result.status).toBe("success");
      const day = (await body(e, daySlug(RANDOM, "2026-11-14")))!;
      expect(day).toContain("msg-30");
      expect(day).toContain("msg-06");
      expect(day).not.toContain("msg-05");
      expect(JSON.parse((await readCursor(e, account.id, slackStream(RANDOM)))!)).toEqual({ v: 1, through: "2026-11-16" });
    } finally { await db.close(); }
  });

  it("rebuilds a day whose message was edited inside the lookback, reading only that day's threads", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      await run(db.storage, w, account.id);
      const parent = w.messages[GENERAL]![0]!;
      w.messages[GENERAL]![0] = { ...parent, text: "Ship it today, <@U0BEN00001>?", edited: { ts: slackTs("2026-11-16T08:00:00Z") } };
      w.calls.length = 0;

      const result = await run(db.storage, w, account.id, T0 + HOUR);
      expect(result.status).toBe("success");
      expect(result.counts.pages_written).toBe(1);
      expect(await body(e, daySlug(GENERAL, "2026-11-14"))).toContain("Ship it today, @Ben Okafor?");
      expect(slackCalls(w, "conversations.replies").map(q => q.get("ts"))).toEqual([parent.ts]);
    } finally { await db.close(); }
  });

  it("picks up an edited thread reply inside the lookback by the next UTC day, without reading threads every run", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w, [GENERAL]);
      await run(db.storage, w, account.id);
      const parent = w.messages[GENERAL]![0]!;
      const reply = w.replies![`${GENERAL}:${parent.ts}`]![0]!;
      w.replies![`${GENERAL}:${parent.ts}`]![0] = { ...reply, text: "yes, after the fix", edited: { ts: slackTs("2026-11-16T13:00:00Z") } };

      w.calls.length = 0;
      await run(db.storage, w, account.id, T0 + HOUR);
      expect(slackCalls(w, "conversations.replies")).toHaveLength(0);

      w.calls.length = 0;
      const nextDay = await run(db.storage, w, account.id, T0 + 24 * HOUR);
      expect(nextDay.counts.pages_written).toBe(1);
      expect(slackCalls(w, "conversations.replies").map(q => q.get("ts"))).toEqual([parent.ts]);
      expect(await body(e, daySlug(GENERAL, "2026-11-14"))).toContain("yes, after the fix");
    } finally { await db.close(); }
  });

  it("reconnects a renamed workspace's pasted token onto its own account by team id", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w, [GENERAL]);
      const renamed = slackFetch(w);
      const deps: ConnectDeps = {
        engine: e, kek, providers: providers(), env: ENV, now: () => T0,
        fetch: async (url, init) => {
          const res = await renamed(url, init);
          if (new URL(url).pathname !== "/api/auth.test") return res;
          const json = await res.json() as Record<string, unknown>;
          return Response.json({ ...json, team: "Example Team Renamed" }, { headers: res.headers });
        },
      };
      const again = await connectApiKey(deps, { provider: "slack", sourceId: SOURCE, apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" });
      expect(again.reconnected).toBe(true);
      expect(again.account.id).toBe(account.id);
      expect(again.account.account_label).toBe(SLACK_TEAM.name);
      expect(await count(e, "SELECT count(*)::int AS n FROM connector_accounts")).toBe(1);
    } finally { await db.close(); }
  });

  it("reconnects a renamed workspace over OAuth onto its own account by team id", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
      const w = world();
      const plain = slackFetch(w);
      let rename = false;
      const deps: ConnectDeps = {
        engine: e, kek, providers: providers(), env: {}, now: () => T0,
        fetch: async (url, init) => {
          const res = await plain(url, init);
          if (!rename || new URL(url).pathname !== "/api/auth.test") return res;
          const json = await res.json() as Record<string, unknown>;
          return Response.json({ ...json, team: "Example Team Renamed" }, { headers: res.headers });
        },
      };
      const { account } = await oauthConnect(deps);
      rename = true;
      const again = await oauthConnect(deps);
      expect(again.reconnected).toBe(true);
      expect(again.account.id).toBe(account.id);
      expect(again.account.account_label).toBe(SLACK_TEAM.name);
      expect(await count(e, "SELECT count(*)::int AS n FROM connector_accounts")).toBe(1);
    } finally { await db.close(); }
  });

  it("refuses an OAuth connect for private channels alone", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "chat", pathPrefix: "chat/" });
      await setOAuthClient(e, kek, "slack", "111.222", "byo-slack-client-secret");
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: slackFetch(world()), env: {}, now: () => T0 };
      const err = await startConnect(deps, {
        provider: "slack", sourceId: SOURCE, services: ["slack_private"], principalRef: "admin:operator", adminSessionId: SESSION,
        redirectUri: connectorCallbackUri("https://brain.example.test", "slack"),
      }).catch(x => x);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("unknown_service");
    } finally { await db.close(); }
  });

  it("keeps a reply posted on a later day with its thread, dated", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const parent = w.messages[GENERAL]![0]!;
      const late = slackTs("2026-11-15T16:30:00Z", 8);
      w.messages[GENERAL]![0] = { ...parent, reply_count: 2, latest_reply: late };
      w.replies![`${GENERAL}:${parent.ts}`]!.push({ ts: late, user: "U0ANA00001", text: "merged", thread_ts: parent.ts });
      const account = await pasteToken(db.storage, w, [GENERAL]);
      await run(db.storage, w, account.id);
      const page = (await body(e, daySlug(GENERAL, "2026-11-14")))!;
      expect(page).toContain("merged");
      expect(page).toContain("2026-11-15 16:30 Ana Lee (reply)");
      expect(page).toMatch(/\n10:05 Ben Okafor \(reply\)/);
      expect(await body(e, daySlug(GENERAL, "2026-11-15"))).not.toContain("merged");
    } finally { await db.close(); }
  });

  it("deletes a day whose messages are all gone upstream, inside the lookback", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      await run(db.storage, w, account.id);
      w.messages[RANDOM] = [];
      const result = await run(db.storage, w, account.id, T0 + HOUR);
      expect(result.counts.deletions_applied).toBe(1);
      expect(await body(e, daySlug(RANDOM, "2026-11-15"))).toBeNull();
      expect(await count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NOT NULL`, [daySlug(RANDOM, "2026-11-15")])).toBe(1);
    } finally { await db.close(); }
  });

  it("keeps a stored day that Slack answers empty once, deleting only when a second read agrees", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      await run(db.storage, w, account.id);
      w.blankHistory = { channel: RANDOM, day: "2026-11-15", times: 1 };
      const result = await run(db.storage, w, account.id, T0 + HOUR);
      expect(result.counts.deletions_applied ?? 0).toBe(0);
      expect(await body(e, daySlug(RANDOM, "2026-11-15"))).toContain("lunch?");
    } finally { await db.close(); }
  });

  it("stops reading a channel taken off the allowlist and keeps the pages it wrote", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      await run(db.storage, w, account.id);
      await setAccountConfig(e, account.id, { channels: [GENERAL] });
      w.messages[RANDOM]!.push({ ts: slackTs("2026-11-16T09:00:00Z", 9), user: "U0BEN00001", text: "pizza" });
      w.calls.length = 0;

      const result = await run(db.storage, w, account.id, T0 + HOUR);
      expect(result.status).toBe("nothing_new");
      expect(w.calls.filter(c => c.params.get("channel") === RANDOM)).toHaveLength(0);
      expect(await body(e, daySlug(RANDOM, "2026-11-15"))).toContain("lunch?");
      expect(await body(e, daySlug(RANDOM, "2026-11-16"))).toBeNull();
    } finally { await db.close(); }
  });

  it("stops a run already under way from reading a channel taken off the allowlist meanwhile", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      const rt = connectorRuntime(db.storage, {
        kek, providers: providers(), fetch: slackFetch(w), env: ENV, now: () => T0, sleep: async () => {},
        embedFn: async (t: string) => deterministicEmbed(t),
      });
      const started = (await rt.loadAccount(account.id))!;
      await setAccountConfig(e, account.id, { channels: [GENERAL] });
      await runConnectorSync(db.storage, started, rt.depsFor(started));
      expect(slackCalls(w, "conversations.history").filter(p => p.get("channel") === RANDOM)).toHaveLength(0);
      expect(await body(e, daySlug(RANDOM, "2026-11-15"))).toBeNull();
      expect(await body(e, daySlug(GENERAL, "2026-11-15"))).toContain("Deploy done");
    } finally { await db.close(); }
  });

  it("waits out a short rate limit, and ends partial with the cursor kept when Slack asks for longer", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w, [GENERAL]);
      w.rateLimit = { method: "conversations.history", retryAfter: "2", times: 1 };
      const waited = await run(db.storage, w, account.id);
      expect(waited.status).toBe("success");

      w.rateLimit = { method: "conversations.history", retryAfter: "120" };
      const before = await readCursor(e, account.id, slackStream(GENERAL));
      const limited = await run(db.storage, w, account.id, T0 + HOUR);
      expect(limited.status).toBe("partial");
      expect(limited.stop_reason).toBe("fetch_failed");
      expect(limited.error_class).toBe("rate_limited");
      expect(await readCursor(e, account.id, slackStream(GENERAL))).toBe(before);
    } finally { await db.close(); }
  });

  it("holds a channel the bot was not invited to and syncs the others; the hold clears once it is", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      w.channels[SECRET] = { name: "plans", is_member: false };
      w.messages[SECRET] = [{ ts: slackTs("2026-11-15T08:00:00Z", 7), user: "U0ANA00001", text: "roadmap" }];
      const account = await pasteToken(db.storage, w, [GENERAL, SECRET]);
      const first = await run(db.storage, w, account.id);
      expect(first.counts.items_held).toBe(1);
      expect(await heldItemCount(e, account.id)).toBe(1);
      expect(await body(e, daySlug(GENERAL, "2026-11-15"))).toContain("Deploy done");
      expect(slackCalls(w, "conversations.history").some(q => q.get("channel") === SECRET)).toBe(false);

      w.channels[SECRET]!.is_member = true;
      const second = await run(db.storage, w, account.id, T0 + HOUR);
      expect(second.counts.pages_written).toBe(1);
      expect(await heldItemCount(e, account.id)).toBe(0);
      expect(await body(e, daySlug(SECRET, "2026-11-15"))).toContain("roadmap");
    } finally { await db.close(); }
  });

  it("skips a private channel unless the account was granted private channels", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      w.channels[SECRET] = { name: "plans", is_private: true };
      w.messages[SECRET] = [{ ts: slackTs("2026-11-15T08:00:00Z", 7), user: "U0ANA00001", text: "roadmap" }];
      const account = await pasteToken(db.storage, w, [SECRET]);
      const result = await run(db.storage, w, account.id);
      expect(result.counts.items_held).toBe(1);
      expect(await body(e, daySlug(SECRET, "2026-11-15"))).toBeNull();
      expect(slackCalls(w, "conversations.history")).toHaveLength(0);
    } finally { await db.close(); }
  });

  it("marks a granted private channel's day pages private, and a public channel's not", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      w.scope = `${SLACK_PUBLIC_SCOPE},${SLACK_PRIVATE_SCOPES.join(",")}`;
      w.channels[SECRET] = { name: "plans", is_private: true };
      w.messages[SECRET] = [{ ts: slackTs("2026-11-15T08:00:00Z", 7), user: "U0ANA00001", text: "roadmap" }];
      const account = await pasteToken(db.storage, w, [SECRET, RANDOM]);
      expect(account.services).toContain("slack_private");
      await run(db.storage, w, account.id);

      const page = async (slug: string) => (await e.query<{ compiled_truth: Record<string, unknown>; markdown_body: string }>(
        `SELECT compiled_truth, markdown_body FROM pages WHERE slug = $1`, [slug])).rows[0]!;
      const secret = await page(daySlug(SECRET, "2026-11-15"));
      expect(secret.markdown_body).toContain("Private chat channel day");
      expect(secret.compiled_truth.private).toBe(true);
      const open_ = await page(daySlug(RANDOM, "2026-11-15"));
      expect(open_.markdown_body).not.toContain("Private");
      expect(open_.compiled_truth.private).toBeUndefined();
    } finally { await db.close(); }
  });

  it("a refused token parks the account for a reconnect and keeps its cursors", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w, [GENERAL]);
      await run(db.storage, w, account.id);
      const cursor = await readCursor(e, account.id, slackStream(GENERAL));
      const revoked = slackFetch(w);
      const rt = connectorRuntime(db.storage, {
        kek, providers: providers(), env: ENV, now: () => T0 + HOUR, sleep: async () => {},
        fetch: async (url, init) => (new URL(url).pathname === "/api/conversations.info" ? Response.json({ ok: false, error: "token_revoked" }) : revoked(url, init)),
      });
      const loaded = (await rt.loadAccount(account.id))!;
      const result = await runConnectorSync(db.storage, loaded, rt.depsFor(loaded));
      expect(result.status).toBe("auth_required");
      expect((await getAccount(e, account.id))!.status).toBe("needs_reconnect");
      expect(await readCursor(e, account.id, slackStream(GENERAL))).toBe(cursor);
      expect(JSON.stringify(result)).not.toContain(SLACK_BOT_TOKEN);
    } finally { await db.close(); }
  });

  it("disconnecting one of two accounts on the same workspace token drops only its own credential", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const first = await pasteToken(db.storage, w);
      await registerSource(e, { id: "team-chat-2", kind: "chat", pathPrefix: "chat2/" });
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: slackFetch(w), env: ENV, now: () => T0 };
      const { account: second } = await connectApiKey(deps, { provider: "slack", sourceId: "team-chat-2", apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" });
      expect(second.id).not.toBe(first.id);

      expect(await disconnectAccount(deps, first.id)).toEqual({ revoked: false, credentialKept: false });
      expect(slackCalls(w, "auth.revoke")).toHaveLength(0);
      expect(await readCredential(e, kek, first.id)).toBeNull();
      expect((await getAccount(e, first.id))!.status).toBe("revoked");
      expect((await readCredential(e, kek, second.id))!.tokens.access_token).toBe(SLACK_BOT_TOKEN);

      // The last account of the workspace revokes the token at Slack.
      expect(await disconnectAccount(deps, second.id)).toEqual({ revoked: true, credentialKept: false });
      expect(slackCalls(w, "auth.revoke")).toHaveLength(1);
    } finally { await db.close(); }
  });

  it("disconnecting a pasted token revokes it at Slack and drops the credential", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await pasteToken(db.storage, w);
      const out = await disconnectAccount({ engine: e, kek, providers: providers(), fetch: slackFetch(w), env: ENV }, account.id);
      expect(out).toEqual({ revoked: true, credentialKept: false });
      expect(slackCalls(w, "auth.revoke")).toHaveLength(1);
      expect(await readCredential(e, kek, account.id)).toBeNull();
    } finally { await db.close(); }
  });
});
