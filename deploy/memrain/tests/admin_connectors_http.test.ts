import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fakeProvider, TEST_ACCESS_TOKEN, testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { listAccounts, markNeedsReconnect } from "../src/core/connectors/accounts.ts";
import { getOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { handleAdminConnectors, handleConnectorCallbackPage, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { isSameOriginPost } from "../src/http/same-origin.ts";
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
      // A no-referrer page makes the browser post with `Origin: null`, which the
      // same-origin gate refuses (seen live). strict-origin keeps a real Origin.
      expect(page.headers.get("referrer-policy")).toBe("strict-origin");
      const completeUrl = new URL(`${ORIGIN}/admin/api/connectors/test/complete`);
      expect(isSameOriginPost(new Request(completeUrl.toString(), { method: "POST", headers: { origin: "null" } }), completeUrl, ORIGIN)).toBe(false);
      const html = await page.text();
      expect(html).not.toContain("<script>");
      expect(html).toContain(`action="/admin/api/connectors/test/complete"`);
      expect(html).toContain(state);

      const form = new URLSearchParams({ state, code: "auth-code" }).toString();
      const done = await call(post("/admin/api/connectors/test/complete", form, "application/x-www-form-urlencoded"), d);
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe("/admin/?connector=connected#connections");
      const accounts = await listAccounts(db.storage.engine());
      expect(accounts.map((a) => [a.account_label, a.enabled])).toEqual([["owner@example.test", false]]);

      const listed = await call(new Request(`${ORIGIN}/admin/api/connectors`), d);
      const text = await listed.text();
      expect(text).toContain("owner@example.test");
      expect(text).not.toContain(TEST_ACCESS_TOKEN);
      expect(text).not.toContain("env-secret");
    } finally { await db.close(); }
  });

  it("binds a Reconnect to its row: another account is refused and nothing is added; the same one comes back reconnected", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await registerSource(e, { id: "work-inbox", kind: "mailbox", pathPrefix: "/work-inbox" });
      const start = (body: Record<string, unknown>, d: AdminConnectorDeps) => call(post("/admin/api/connectors/test/start", JSON.stringify(body)), d);
      const flow = async (body: Record<string, unknown>, d: AdminConnectorDeps) => {
        const started = await start(body, d);
        expect(started.status).toBe(200);
        const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get("state")!;
        return call(post("/admin/api/connectors/test/complete", new URLSearchParams({ state, code: "auth-code" }).toString(), "application/x-www-form-urlencoded"), d);
      };
      const first = await flow({ source_id: "inbox", services: ["mail"] }, deps(db.storage, "sess-1"));
      expect(first.headers.get("location")).toBe("/admin/?connector=connected#connections");
      const row = (await listAccounts(e))[0]!;
      await markNeedsReconnect(e, row.id, "invalid_grant");

      // Reconnect on the row, and the owner picks another account at the provider (another address, so no label matches).
      const otherAccount = deps(db.storage, "sess-1", { fetch: fakeProvider({ identity: "someone-else@example.test" }).fetch });
      const wrong = await flow({ source_id: "inbox", services: ["mail"], account_id: row.id }, otherAccount);
      expect(wrong.headers.get("location")).toBe("/admin/?connector_error=identity_mismatch#connections");
      expect((await listAccounts(e)).map((a) => [a.account_label, a.status])).toEqual([["owner@example.test", "needs_reconnect"]]);

      const right = await flow({ source_id: "inbox", services: ["mail"], account_id: row.id }, deps(db.storage, "sess-1"));
      expect(right.headers.get("location")).toBe("/admin/?connector=reconnected#connections");
      expect((await listAccounts(e)).map((a) => [a.id, a.status])).toEqual([[row.id, "active"]]);

      // A row that does not exist, or belongs to another source, starts nothing.
      for (const body of [
        { source_id: "inbox", services: ["mail"], account_id: "0f0f0f0f-0000-4000-8000-00000000abcd" },
        { source_id: "inbox", services: ["mail"], account_id: "not-an-id" },
        { source_id: "work-inbox", services: ["mail"], account_id: row.id },
      ]) {
        const refused = await start(body, deps(db.storage, "sess-1"));
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: "account_not_found" });
      }
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
      expect(res.headers.get("location")).toBe("/admin/?connector_error=state_session#connections");
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
      expect(await getOAuthClient(db.storage.engine(), kek, "test")).toEqual({ clientId: "byo-id", clientSecret: "byo-secret-value", tenant: null });
      const unknown = await call(post("/admin/api/connectors/nope/client", JSON.stringify({ client_id: "a", client_secret: "b" })), d);
      expect(unknown.status).toBe(400);
    } finally { await db.close(); }
  });

  it("stores a client's tenant only for a provider with tenants, and lists it with the provider's default", async () => {
    const db = await open();
    try {
      const providers = registry();
      providers.register({
        ...testProvider("dir"),
        authorizeUrl: "https://login.provider.test/{tenant}/authorize",
        tokenUrl: "https://login.provider.test/{tenant}/token",
        revokeUrl: undefined,
        tenant: { default: "common" },
      });
      const d = deps(db.storage, "sess-1", { providers });
      const save = (provider: string, body: Record<string, unknown>) => call(post(`/admin/api/connectors/${provider}/client`, JSON.stringify(body)), d);

      const saved = await save("dir", { client_id: "dir-id", client_secret: "dir-secret-value", tenant: "Contoso.onmicrosoft.com" });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true, provider: "dir", client_id: "dir-id", tenant: "contoso.onmicrosoft.com" });
      expect((await save("dir", { client_id: "dir-id", client_secret: "dir-secret-value", tenant: "common/../x" })).status).toBe(400);
      const bad = await save("dir", { client_id: "dir-id", client_secret: "dir-secret-value", tenant: "a b" });
      expect(await bad.json()).toEqual({ error: "invalid_tenant" });
      const unsupported = await save("test", { client_id: "byo-id", client_secret: "byo-secret-value", tenant: "common" });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toEqual({ error: "tenant_unsupported" });
      expect((await getOAuthClient(db.storage.engine(), kek, "dir"))?.tenant).toBe("contoso.onmicrosoft.com");

      const report = await (await call(new Request(`${ORIGIN}/admin/api/connectors`), d)).json() as {
        providers: Array<{ id: string; tenant_default: string | null; can_revoke: boolean }>;
        clients: Array<{ provider: string; tenant: string | null }>;
      };
      expect(report.providers.map((p) => [p.id, p.tenant_default, p.can_revoke])).toEqual([["test", null, true], ["dir", "common", false]]);
      expect(report.clients.map((c) => [c.provider, c.tenant])).toEqual([["dir", "contoso.onmicrosoft.com"]]);
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

describe("connector callback page after an administrator's consent", () => {
  const TENANT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const landing = (query: Record<string, string>) => {
    const u = new URL(`${ORIGIN}/admin/connectors/callback/microsoft`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return handleConnectorCallbackPage(new Request(u.toString()), u)!;
  };
  const sameHeaders = (page: Response) => {
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin");
  };

  it("says the consent was recorded, with nothing to post and no tenant echoed", async () => {
    // What Microsoft's /adminconsent endpoint sends back: no code and none of our states.
    const page = landing({ admin_consent: "True", tenant: TENANT, scope: "https://graph.microsoft.com/Mail.Read" });
    sameHeaders(page);
    const html = await page.text();
    expect(html).toContain("Admin consent recorded at Microsoft");
    expect(html).toContain("Connections page");
    expect(html).toContain("You can close this tab");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(TENANT);
  });

  it("says the consent was not recorded when Microsoft answers with an error, quoting only its codes", async () => {
    const page = landing({
      admin_consent: "True", error: "consent_required", state: "12345",
      error_description: "AADSTS65004: The resource owner or authorization server denied the request. <script>x</script>",
    });
    sameHeaders(page);
    const html = await page.text();
    expect(html).toContain("did not record");
    expect(html).toContain("consent_required");
    expect(html).toContain("AADSTS65004");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("resource owner");
  });

  it("finishes nothing for a visit that carries neither a code nor a state", async () => {
    for (const query of [{}, { error: "access_denied" }, { error: "<b>" }] as Array<Record<string, string>>) {
      const page = landing(query);
      sameHeaders(page);
      const html = await page.text();
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<b>");
      expect(html).toContain("Connections page");
    }
  });

  it("still hands the owner's own refusal to the connect, which consumes its state", async () => {
    const html = await landing({ state: "s".repeat(43), error: "access_denied", error_description: "AADSTS65004: declined" }).text();
    expect(html).toContain(`action="/admin/api/connectors/microsoft/complete"`);
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
      // The shipped providers are listed (no secrets in them) while nothing can connect.
      const status = await st?.json() as { enabled: boolean; accounts: unknown[]; providers: unknown[] };
      expect(status).toMatchObject({ enabled: false, accounts: [] });
      expect(status.providers).toContainEqual(expect.objectContaining({
        id: "google", services: ["calendar", "gmail"], service_kinds: { calendar: ["calendar"], gmail: ["mailbox"] }, auth: "oauth",
      }));
      expect(status.providers).toContainEqual(expect.objectContaining({ id: "fireflies", services: ["fireflies"], auth: "api_key", callback_uri: null }));
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await db.close();
    }
  });
});
