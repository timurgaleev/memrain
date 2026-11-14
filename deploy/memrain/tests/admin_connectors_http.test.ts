import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fakeProvider, TEST_ACCESS_TOKEN, testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { listAccounts } from "../src/core/connectors/accounts.ts";
import { getOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { handleAdminConnectors, handleConnectorCallbackPage, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = "https://brain.example.test";
const kek = kekFromBytes(randomBytes(32));
const ENV = { MEMRAIN_TEST_OAUTH_CLIENT_ID: "env-client", MEMRAIN_TEST_OAUTH_CLIENT_SECRET: "env-secret" };

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(testProvider("test"));
  return r;
}

function deps(storage: Storage, session: string | null, extra: Partial<AdminConnectorDeps> = {}): AdminConnectorDeps {
  const fake = fakeProvider();
  return {
    storage,
    publicUrl: ORIGIN,
    adminSessionId: () => session,
    status: () => ({ enabled: true, kekId: kek.id, reason: null }),
    kek: () => kek,
    providers: registry(),
    fetch: fake.fetch,
    env: ENV,
    ...extra,
  };
}

function post(path: string, body: string, type = "application/json"): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": type }, body });
}

async function call(req: Request, d: AdminConnectorDeps): Promise<Response> {
  const res = await handleAdminConnectors(req, new URL(req.url), d);
  if (!res) throw new Error("route not handled");
  return res;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin connector routes (${name})`, () => {
  it("refuse to start while connectors are off, and say why", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const off = deps(db.storage, "sess-1", {
        status: () => ({ enabled: false, kekId: null, reason: "no connector key" }), kek: () => null,
      });
      const res = await call(post("/admin/api/connectors/test/start", JSON.stringify({ source_id: "inbox", services: ["mail"] })), off);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "connectors_disabled", reason: "no connector key" });
      const st = await call(new Request(`${ORIGIN}/admin/api/connectors`), off);
      expect(await st.json()).toMatchObject({ enabled: false, reason: "no connector key", accounts: [] });
    } finally { await db.close(); }
  });

  it("connect end to end: start, provider bounce page, complete from the same session", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const d = deps(db.storage, "sess-1");
      const started = await call(post("/admin/api/connectors/test/start", JSON.stringify({ source_id: "inbox", services: ["mail"] })), d);
      expect(started.status).toBe(200);
      const { authorize_url } = await started.json() as { authorize_url: string };
      const state = new URL(authorize_url).searchParams.get("state")!;

      const cbUrl = new URL(`${ORIGIN}/admin/connectors/callback/test`);
      cbUrl.searchParams.set("state", state);
      cbUrl.searchParams.set("code", `abc"><script>x</script>`);
      const page = handleConnectorCallbackPage(new Request(cbUrl.toString()), cbUrl)!;
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toContain("no-store");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
      const html = await page.text();
      expect(html).not.toContain("<script>");
      expect(html).toContain(`action="/admin/api/connectors/test/complete"`);
      expect(html).toContain(state);

      const form = new URLSearchParams({ state, code: "auth-code" }).toString();
      const done = await call(post("/admin/api/connectors/test/complete", form, "application/x-www-form-urlencoded"), d);
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe("/admin/?connector=connected");
      const accounts = await listAccounts(db.storage.engine());
      expect(accounts.map((a) => [a.account_label, a.enabled])).toEqual([["owner@example.test", false]]);

      const listed = await call(new Request(`${ORIGIN}/admin/api/connectors`), d);
      const text = await listed.text();
      expect(text).toContain("owner@example.test");
      expect(text).not.toContain(TEST_ACCESS_TOKEN);
      expect(text).not.toContain("env-secret");
    } finally { await db.close(); }
  });

  it("complete from another session redirects with the error code and creates nothing", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const started = await call(post("/admin/api/connectors/test/start", JSON.stringify({ source_id: "inbox", services: ["mail"] })), deps(db.storage, "sess-1"));
      const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get("state")!;
      const form = new URLSearchParams({ state, code: "attacker" }).toString();
      const res = await call(post("/admin/api/connectors/test/complete", form, "application/x-www-form-urlencoded"), deps(db.storage, "sess-2"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/?connector_error=state_session");
      expect(await listAccounts(db.storage.engine())).toEqual([]);
    } finally { await db.close(); }
  });

  it("stores a bring-your-own client and never returns its secret", async () => {
    const db = await open();
    try {
      const d = deps(db.storage, "sess-1");
      const res = await call(post("/admin/api/connectors/test/client", JSON.stringify({ client_id: "byo-id", client_secret: "byo-secret-value" })), d);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("byo-secret-value");
      expect(await getOAuthClient(db.storage.engine(), kek, "test")).toEqual({ clientId: "byo-id", clientSecret: "byo-secret-value" });
      const unknown = await call(post("/admin/api/connectors/nope/client", JSON.stringify({ client_id: "a", client_secret: "b" })), d);
      expect(unknown.status).toBe(400);
    } finally { await db.close(); }
  });
});

describe("connector callback page", () => {
  it("handles only its own path and a valid provider name", () => {
    expect(handleConnectorCallbackPage(new Request(`${ORIGIN}/admin/other`), new URL(`${ORIGIN}/admin/other`))).toBeNull();
    const bad = new URL(`${ORIGIN}/admin/connectors/callback/Bad%20Name`);
    expect(handleConnectorCallbackPage(new Request(bad.toString()), bad)?.status).toBe(404);
    const post = new URL(`${ORIGIN}/admin/connectors/callback/test`);
    expect(handleConnectorCallbackPage(new Request(post.toString(), { method: "POST" }), post)?.status).toBe(405);
    const malformed = new URL(`${ORIGIN}/admin/connectors/callback/%E0%A4%A`);
    expect(handleConnectorCallbackPage(new Request(malformed.toString()), malformed)?.status).toBe(404);
  });
});

describe("connector routes behind handleAdminApi", () => {
  it("are registered, gated by the admin session, and off by default", async () => {
    const db = await storageEngines(undefined)[0]!.open();
    const keys = ["MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE"] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      const base = { storage: db.storage, publicUrl: ORIGIN, adminSessionId: () => "sess-1" };
      const statusUrl = new URL(`${ORIGIN}/admin/api/connectors`);
      const anon = await handleAdminApi(new Request(statusUrl.toString()), statusUrl, { ...base, requireAdmin: () => false });
      expect(anon?.status).toBe(401);
      const req = post("/admin/api/connectors/google/start", JSON.stringify({ source_id: "default", services: ["mail"] }));
      const res = await handleAdminApi(req, new URL(req.url), { ...base, requireAdmin: () => true });
      expect(res?.status).toBe(403);
      expect(await res?.json()).toMatchObject({ error: "connectors_disabled" });
      const st = await handleAdminApi(new Request(statusUrl.toString()), statusUrl, { ...base, requireAdmin: () => true });
      expect(await st?.json()).toMatchObject({ enabled: false, providers: [] });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await db.close();
    }
  });
});
