/**
 * The Microsoft connect flow and the Outlook calendar picker through the real
 * server (startServer: the admin auth routes, handleAdminApi's session,
 * same-origin and cooldown gates, the callback page), driven with the headers
 * a browser sends, behind a TLS proxy that keeps Host. The provider is the
 * shipped one from builtinProviders, configured only by the environment the
 * docs name (MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID / _SECRET); Microsoft is
 * played by recorded responses, and no request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GRAPH_ACCESS_TOKEN, GRAPH_REFRESH_TOKEN, graphFetch, type GraphWorld } from "./helpers/graph-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import type { Storage } from "../src/core/storage.ts";

setDefaultTimeout(30_000);

const PUBLIC = "https://brain.example.test";
const HOST = "brain.example.test";
const BOOT = `boot-${randomBytes(12).toString("hex")}`;
const OWNER = "owner@example.test";
const TEAM = "AAMkCalTeam0001=";
const ENV_KEYS = [
  "MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_MICROSOFT_OAUTH_TENANT",
  "MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID", "MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET", "MEMRAIN_HTTP_TRUST_PROXY",
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

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin Outlook calendar connect, end to end (${name})`, () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const realFetch = globalThis.fetch;
  let world: GraphWorld;
  let server: ServerHandle | null = null;
  let db: { storage: Storage; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.MEMRAIN_CONNECTORS_ENABLED = "1";
    process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
    process.env.MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID = "00000000-0000-4000-8000-00000000c11e";
    process.env.MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET = "env-ms-client-secret-value";
    world = { calls: [], delta: () => "deltaEmpty" };
    const microsoft = graphFetch(world);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      return microsoft(url, (init ?? {}) as Parameters<typeof microsoft>[1]);
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
    await registerSource(db.storage.engine(), { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
    const port = await freePort();
    server = startServer({ host: "127.0.0.1", port, storage: db.storage, mcpEnabled: false, adminBootstrapToken: BOOT, publicUrl: PUBLIC });
    const b = browser(port);
    const login = await b.send("/admin/login", {
      method: "POST",
      headers: { ...SPA, origin: PUBLIC, "content-type": "application/json" },
      body: JSON.stringify({ token: BOOT }),
    });
    expect(login.status).toBe(200);
    b.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    return b;
  }

  it("connects a Microsoft calendar, lists it, and picks its calendars, through every gate", async () => {
    const b = await boot();
    const listedProviders = await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { providers: Array<{ id: string; services: string[] }> };
    expect(listedProviders.providers.find(p => p.id === "microsoft")).toMatchObject({ services: ["outlook_mail", "outlook_calendar"] });

    const started = await b.send("/admin/api/connectors/microsoft/start", {
      method: "POST",
      headers: { ...SPA, origin: PUBLIC, "content-type": "application/json" },
      body: JSON.stringify({ source_id: "cal", services: ["outlook_calendar"] }),
    });
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { authorize_url: string }).authorize_url);
    expect(authorize.origin + authorize.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/admin/connectors/callback/microsoft`);

    // Microsoft sends the browser back with the code in the query (response_mode=query): a cross-site navigation.
    const back = new URL(authorize.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "M.C512_test-auth-code");
    back.searchParams.set("state", authorize.searchParams.get("state")!);
    back.searchParams.set("session_state", "00000000-0000-4000-8000-0000000000ss");
    const page = await b.send(`${back.pathname}${back.search}`, {
      withCookie: false,
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", referer: "https://login.microsoftonline.com/" },
    });
    expect(page.status).toBe(200);
    const { action, fields } = formFields(await page.text());
    expect(action).toBe("/admin/api/connectors/microsoft/complete");
    const done = await b.send(action, {
      method: "POST",
      headers: {
        origin: formPostOrigin(page.headers.get("referrer-policy")), "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
      },
      body: new URLSearchParams(fields).toString(),
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/?connector=connected#connections");

    const text = await (await b.send("/admin/api/connectors", { headers: SPA })).text();
    for (const secret of [GRAPH_ACCESS_TOKEN, GRAPH_REFRESH_TOKEN, "env-ms-client-secret-value"]) expect(text).not.toContain(secret);
    const { accounts } = JSON.parse(text) as { accounts: Array<Record<string, unknown> & { id: string }> };
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "microsoft", source_id: "cal", account_label: OWNER, status: "active", enabled: false, grant_expiry: null });
    const id = accounts[0]!.id;

    const calendars = await b.send(`/admin/api/connectors/accounts/${id}/calendars`, { headers: SPA });
    expect(calendars.status).toBe(200);
    expect(await calendars.json()).toEqual({
      calendars: [
        { id: "AAMkCalDefault01=", summary: "Calendar", primary: true, access_role: "writer", selected: true },
        { id: TEAM, summary: "Team", primary: false, access_role: "reader", selected: false },
      ],
      history_days: 90,
    });
    // The list is read with the calendar service's Graph headers.
    expect(world.calls.find(c => c.url.pathname === "/v1.0/me/calendars")!.prefer).toContain("outlook.timezone=\"UTC\"");

    const save = (origin: string) => b.send(`/admin/api/connectors/accounts/${id}/calendars`, {
      method: "POST",
      headers: { ...SPA, origin, "content-type": "application/json" },
      body: JSON.stringify({ calendars: ["AAMkCalDefault01=", TEAM], history_days: 30 }),
    });
    expect((await save("https://evil.example.test")).status).toBe(403);
    const saved = await save(PUBLIC);
    expect(saved.status).toBe(200);
    // The default calendar always syncs and is not stored.
    expect(await saved.json()).toEqual({ ok: true, calendars: [TEAM], history_days: 30 });
  });
});
