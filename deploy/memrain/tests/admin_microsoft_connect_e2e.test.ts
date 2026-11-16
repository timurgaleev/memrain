/**
 * The whole Microsoft connect flow through the real server (startServer: the
 * admin sign-in, handleAdminApi's session, same-origin and cooldown gates, the
 * callback page), driven with the headers a browser sends, behind a TLS proxy
 * that keeps Host:
 *
 *   sign in → save the bring-your-own Entra app with its tenant → list →
 *   start (fetch from the SPA) → Microsoft's redirect to the callback page
 *   (cross-site navigation, no session cookie) → the page's form post to
 *   /complete → the account is listed → disconnect, which calls nothing at
 *   Microsoft and names where the owner withdraws the consent.
 *
 * Microsoft is played by recorded responses (tests/fixtures/connectors); no
 * request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { MS_ACCESS_TOKEN, MS_REFRESH_TOKEN, microsoftFetch, tokenTenant, type MicrosoftWorld } from "./helpers/microsoft-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import type { Storage } from "../src/core/storage.ts";

setDefaultTimeout(30_000);

const PUBLIC = "https://brain.example.test";
const HOST = "brain.example.test";
const BOOT = `boot-${randomBytes(12).toString("hex")}`;
const TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const APP_ID = "11111111-2222-3333-4444-a55555555555";
const APP_SECRET = "byo-entra-secret-value~0123456789";
const ENV_KEYS = [
  "MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE",
  "MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID", "MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET", "MEMRAIN_MICROSOFT_OAUTH_TENANT", "MEMRAIN_HTTP_TRUST_PROXY",
] as const;

/** The SPA's fetch() from our own page. */
const SPA = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

interface Browser {
  cookie: string | null;
  send(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; withCookie?: boolean }): Promise<Response>;
}

function browser(port: number): Browser {
  const b: Browser = {
    cookie: null,
    send(path, init = {}) {
      const headers: Record<string, string> = { host: HOST, ...init.headers };
      if (init.withCookie !== false && b.cookie) headers.cookie = b.cookie;
      return fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual" });
    },
  };
  return b;
}

const spaPost = (b: Browser, path: string, body: unknown, origin = PUBLIC) =>
  b.send(path, { method: "POST", headers: { ...SPA, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

/** The Origin a browser puts on a form POST from a page served with this Referrer-Policy. */
function formPostOrigin(referrerPolicy: string | null): string {
  return (referrerPolicy ?? "").split(",").map((p) => p.trim()).includes("no-referrer") ? "null" : PUBLIC;
}

function formFields(html: string): { action: string; fields: Record<string, string> } {
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error("callback page has no form");
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[m[1]!] = m[2]!.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  }
  return { action, fields };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin Microsoft connect, end to end (${name})`, () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const realFetch = globalThis.fetch;
  let world: MicrosoftWorld;
  let server: ServerHandle | null = null;
  let db: { storage: Storage; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.MEMRAIN_CONNECTORS_ENABLED = "1";
    process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
    world = { calls: [] };
    // The server's provider calls go to the recorded Microsoft; the browser's go to the server.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      return microsoftFetch(world)(url, (init ?? {}) as Parameters<ReturnType<typeof microsoftFetch>>[1]);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) await server.stop();
    server = null;
    if (db) await db.close();
    db = null;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function boot(): Promise<Browser> {
    db = await open();
    await registerSource(db.storage.engine(), { id: "work-mail", kind: "mailbox", pathPrefix: "mail/" });
    const port = await freePort();
    server = startServer({ host: "127.0.0.1", port, storage: db.storage, mcpEnabled: false, adminBootstrapToken: BOOT, publicUrl: PUBLIC });
    const b = browser(port);
    const login = await spaPost(b, "/admin/login", { token: BOOT });
    expect(login.status).toBe(200);
    b.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    return b;
  }

  async function connectMicrosoft(b: Browser): Promise<Response> {
    const started = await spaPost(b, "/admin/api/connectors/microsoft/start", { source_id: "work-mail", services: ["outlook_mail"] });
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { authorize_url: string }).authorize_url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(authorize.searchParams.get("scope")).toBe("openid email offline_access User.Read Mail.Read");
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
    expect(authorize.searchParams.get("client_id")).toBe(APP_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/admin/connectors/callback/microsoft`);

    // Microsoft sends the browser back with response_mode=query: a cross-site navigation, so no session cookie.
    const back = new URL(authorize.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "M.C5-test-auth-code");
    back.searchParams.set("state", authorize.searchParams.get("state")!);
    back.searchParams.set("session_state", "00000000-0000-0000-0000-0000000000aa");
    const page = await b.send(`${back.pathname}${back.search}`, {
      withCookie: false,
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", referer: "https://login.microsoftonline.com/" },
    });
    expect(page.status).toBe(200);
    const { action, fields } = formFields(await page.text());
    expect(action).toBe("/admin/api/connectors/microsoft/complete");
    return b.send(action, {
      method: "POST",
      headers: {
        origin: formPostOrigin(page.headers.get("referrer-policy")), "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("saves the Entra app with its tenant, connects, lists and disconnects, through every gate", async () => {
    const b = await boot();
    const report = await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { providers: Array<Record<string, unknown>> };
    expect(report.providers.find((p) => p.id === "microsoft")).toEqual({
      id: "microsoft",
      services: ["outlook_mail", "outlook_calendar"],
      service_kinds: { outlook_mail: ["mailbox"], outlook_calendar: ["calendar"] },
      auth: "oauth",
      callback_uri: `${PUBLIC}/admin/connectors/callback/microsoft`,
      tenant_default: "common",
      can_revoke: false,
      consent_urls: ["https://myapplications.microsoft.com", "https://account.microsoft.com/privacy/app-access"],
    });
    expect(report.providers.find((p) => p.id === "google")).toMatchObject({ tenant_default: null, consent_urls: [] });

    // Another site cannot ride the session to swap the app; a bad tenant or a tenant for Google is refused.
    expect((await spaPost(b, "/admin/api/connectors/microsoft/client", { client_id: APP_ID, client_secret: APP_SECRET, tenant: TENANT_ID }, "https://evil.example.test")).status).toBe(403);
    const badTenant = await spaPost(b, "/admin/api/connectors/microsoft/client", { client_id: APP_ID, client_secret: APP_SECRET, tenant: "evil.example/x" });
    expect(badTenant.status).toBe(400);
    expect(await badTenant.json()).toEqual({ error: "invalid_tenant" });
    const googleTenant = await spaPost(b, "/admin/api/connectors/google/client", { client_id: "c.apps.googleusercontent.com", client_secret: "s-value", tenant: "common" });
    expect(googleTenant.status).toBe(400);
    expect(await googleTenant.json()).toEqual({ error: "tenant_unsupported" });

    const saved = await spaPost(b, "/admin/api/connectors/microsoft/client", { client_id: APP_ID, client_secret: APP_SECRET, tenant: TENANT_ID });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, provider: "microsoft", client_id: APP_ID, tenant: TENANT_ID });
    const clients = (await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { clients: Array<Record<string, unknown>> }).clients;
    expect(clients).toEqual([expect.objectContaining({ provider: "microsoft", client_id: APP_ID, tenant: TENANT_ID })]);

    const done = await connectMicrosoft(b);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/?connector=connected#connections");
    const exchange = world.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!;
    expect(tokenTenant(exchange)).toBe(TENANT_ID);
    expect(exchange.body!.get("client_secret")).toBe(APP_SECRET);

    const listed = await b.send("/admin/api/connectors", { headers: SPA });
    const text = await listed.text();
    for (const secret of [MS_ACCESS_TOKEN, MS_REFRESH_TOKEN, APP_SECRET]) expect(text).not.toContain(secret);
    const { accounts } = JSON.parse(text) as { accounts: Array<Record<string, unknown> & { id: string }> };
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "microsoft", source_id: "work-mail", account_label: "owner@example.test", services: ["outlook_mail"], status: "active", enabled: false });

    const calls = world.calls.length;
    const wrong = await spaPost(b, `/admin/api/connectors/accounts/${accounts[0]!.id}/disconnect`, { confirm_label: "someone-else@example.test" });
    expect(wrong.status).toBe(400);
    const off = await spaPost(b, `/admin/api/connectors/accounts/${accounts[0]!.id}/disconnect`, { confirm_label: "owner@example.test" });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      ok: true, revoked: false, credential_kept: false, consent_urls: ["https://myapplications.microsoft.com", "https://account.microsoft.com/privacy/app-access"],
    });
    // Nothing at Microsoft can revoke a delegated grant; the disconnect called nothing.
    expect(world.calls.length).toBe(calls);
    const after = (await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { accounts: Array<Record<string, unknown>> }).accounts;
    expect(after[0]).toMatchObject({ status: "revoked", enabled: false, credential: null });
  });

  it("reports a work tenant that needs an administrator's approval", async () => {
    const b = await boot();
    expect((await spaPost(b, "/admin/api/connectors/microsoft/client", { client_id: APP_ID, client_secret: APP_SECRET, tenant: TENANT_ID })).status).toBe(200);
    world.codeError = "adminConsentRequired";
    const done = await connectMicrosoft(b);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/?connector_error=admin_consent_required#connections");
    const { accounts } = await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { accounts: unknown[] };
    expect(accounts).toEqual([]);
  });

  it("uses the environment's app and tenant when none is saved", async () => {
    process.env.MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID = APP_ID;
    process.env.MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET = APP_SECRET;
    process.env.MEMRAIN_MICROSOFT_OAUTH_TENANT = TENANT_ID;
    const b = await boot();
    expect((await connectMicrosoft(b)).headers.get("location")).toBe("/admin/?connector=connected#connections");
  });
});
