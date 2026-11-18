/**
 * The Connections page's Slack channel picker and the Slack provider as the
 * page sees it: GET lists the channels the bot can see (private ones only for
 * an account granted them) with which of them sync, POST saves an allowlist
 * of channels the bot was invited to, plus the first sync's history window.
 * A pasted bot token goes through the provider's key route. No token reaches
 * a response, and nothing runs while connectors are off. Both engines, against
 * the fake workspace; no request leaves the process.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { SLACK_BOT_TOKEN, SLACK_TEAM, slackCalls, slackFetch, type SlackWorld } from "./helpers/slack-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import { connectApiKey } from "../src/core/connectors/api-key-connect.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { slackProvider } from "../src/core/connectors/slack/provider.ts";
import { handleAdminConnectors, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import type { Storage } from "../src/core/storage.ts";

const kek = kekFromBytes(randomBytes(32));
const ORIGIN = "https://brain.example.test";
const ENV: NodeJS.ProcessEnv = { MEMRAIN_CONNECTORS_ENABLED: "1" };

function deps(storage: Storage, world: SlackWorld, extra: Partial<AdminConnectorDeps> = {}): AdminConnectorDeps {
  const providers = new ProviderRegistry();
  providers.register(slackProvider());
  return {
    storage,
    publicUrl: ORIGIN,
    adminSessionId: () => "sess-1",
    status: () => ({ enabled: true, kekId: kek.id, reason: null }),
    kek: () => kek,
    providers,
    fetch: slackFetch(world),
    env: ENV,
    ...extra,
  };
}

const get = (path: string) => new Request(`${ORIGIN}${path}`);
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(req: Request, d: AdminConnectorDeps): Promise<Response> {
  const res = await handleAdminConnectors(req, new URL(req.url), d);
  if (!res) throw new Error(`route not handled: ${req.method} ${req.url}`);
  return res;
}

function world(scope?: string): SlackWorld {
  return {
    channels: {
      C0GENERAL1: { name: "general" },
      C0RANDOM01: { name: "random", is_member: false },
      G0SECRET01: { name: "plans", is_private: true },
    },
    messages: {},
    ...(scope ? { scope } : {}),
    calls: [],
  };
}

async function slackAccount(storage: Storage, w: SlackWorld): Promise<ConnectorAccount> {
  const e = storage.engine();
  await registerSource(e, { id: "team-chat", kind: "chat", pathPrefix: "chat/" });
  const { account } = await connectApiKey(
    { engine: e, kek, providers: deps(storage, w).providers, fetch: slackFetch(w), env: ENV },
    { provider: "slack", sourceId: "team-chat", apiKey: SLACK_BOT_TOKEN, principalRef: "admin:operator" },
  );
  return account;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin slack channels (${name})`, () => {
  it("lists Slack as an OAuth provider that also takes a pasted token, with private channels opt-in", async () => {
    const db = await open();
    try {
      const res = await call(get("/admin/api/connectors"), deps(db.storage, world()));
      const body = await res.json() as { providers: Array<Record<string, unknown>> };
      expect(body.providers).toEqual([expect.objectContaining({
        id: "slack", auth: "oauth", services: ["slack", "slack_private"], pasted_token: true, opt_in_services: ["slack_private"],
        callback_uri: `${ORIGIN}/admin/connectors/callback/slack`, can_revoke: true,
      })]);
    } finally { await db.close(); }
  });

  it("saves a pasted bot token through the key route, never echoing it", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "team-chat", kind: "chat", pathPrefix: "chat/" });
      const w = world();
      const res = await call(post("/admin/api/connectors/slack/key", { source_id: "team-chat", api_key: SLACK_BOT_TOKEN }), deps(db.storage, w));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SLACK_BOT_TOKEN);
      expect(JSON.parse(text)).toMatchObject({ ok: true, account: { provider: "slack", account_label: SLACK_TEAM.name, enabled: false } });
      expect(slackCalls(w, "auth.test")).toHaveLength(1);

      const wide = await call(post("/admin/api/connectors/slack/key", { source_id: "team-chat", api_key: SLACK_BOT_TOKEN }),
        deps(db.storage, world("channels:history,channels:read,users:read,chat:write")));
      expect(wide.status).toBe(400);
      expect(await wide.json()).toEqual({ error: "scope_mismatch" });
    } finally { await db.close(); }
  });

  it("lists the public channels the bot can see, which of them sync, and whether it was invited", async () => {
    const db = await open();
    try {
      const w = world();
      const account = await slackAccount(db.storage, w);
      const res = await call(get(`/admin/api/connectors/accounts/${account.id}/channels`), deps(db.storage, w));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SLACK_BOT_TOKEN);
      expect(JSON.parse(text)).toEqual({
        channels: [
          { id: "C0GENERAL1", name: "general", is_private: false, is_member: true, selected: false },
          { id: "C0RANDOM01", name: "random", is_private: false, is_member: false, selected: false },
        ],
        history_days: 14,
        private_channels: false,
      });
      expect(slackCalls(w, "conversations.list")[0]!.get("types")).toBe("public_channel");
    } finally { await db.close(); }
  });

  it("lists private channels too for an account granted them", async () => {
    const db = await open();
    try {
      const w = world("channels:history,channels:read,users:read,groups:history,groups:read");
      const account = await slackAccount(db.storage, w);
      const res = await call(get(`/admin/api/connectors/accounts/${account.id}/channels`), deps(db.storage, w));
      const body = await res.json() as { channels: Array<{ id: string }>; private_channels: boolean };
      expect(body.private_channels).toBe(true);
      expect(body.channels.map(c => c.id)).toEqual(["C0GENERAL1", "G0SECRET01", "C0RANDOM01"]);
    } finally { await db.close(); }
  });

  it("saves channels the bot is in, refuses one it was not invited to or Slack does not list", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const w = world();
      const account = await slackAccount(db.storage, w);
      const path = `/admin/api/connectors/accounts/${account.id}/channels`;
      const saved = await call(post(path, { channels: ["C0GENERAL1"], history_days: 30 }), deps(db.storage, w));
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true, channels: ["C0GENERAL1"], history_days: 30 });
      expect((await getAccount(e, account.id))!.config).toMatchObject({ channels: ["C0GENERAL1"], history_days: 30 });

      const uninvited = await call(post(path, { channels: ["C0RANDOM01"] }), deps(db.storage, w));
      expect(uninvited.status).toBe(400);
      expect(await uninvited.json()).toMatchObject({ error: "not_in_channel" });
      const unknown = await call(post(path, { channels: ["G0SECRET01"] }), deps(db.storage, w));
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: "unknown_channel" });
      for (const history_days of [0, 366, 2.5]) {
        const bad = await call(post(path, { history_days }), deps(db.storage, w));
        expect(bad.status).toBe(400);
      }
      expect((await getAccount(e, account.id))!.config).toMatchObject({ channels: ["C0GENERAL1"], history_days: 30 });
    } finally { await db.close(); }
  });

  it("answers connectors_disabled while connectors are off, without asking Slack", async () => {
    const db = await open();
    try {
      const w = world();
      const account = await slackAccount(db.storage, w);
      w.calls.length = 0;
      const off = deps(db.storage, w, { status: () => ({ enabled: false, kekId: null, reason: "MEMRAIN_CONNECTORS_ENABLED is not 1" }) });
      const res = await call(get(`/admin/api/connectors/accounts/${account.id}/channels`), off);
      expect(res.status).toBe(403);
      expect(w.calls).toHaveLength(0);
    } finally { await db.close(); }
  });
});
