/**
 * The whole Google connect flow through the real server (startServer: the
 * admin auth routes, handleAdminApi's session, same-origin and cooldown
 * gates, the callback page), driven with the headers a browser actually
 * sends, behind a TLS proxy that keeps Host (MEMRAIN_PUBLIC_URL is https,
 * the server sees http):
 *
 *   sign in → list → start (fetch from the SPA) → Google's redirect to the
 *   callback page (cross-site navigation: no session cookie) → the page's
 *   form post to /complete (Origin as the page's referrer policy makes the
 *   browser send it, plus the session cookie) → the account is listed →
 *   its calendars are listed and saved.
 *
 * The browser model derives the form post's Origin from the callback page's
 * own Referrer-Policy: under `no-referrer` a browser sends `Origin: null`,
 * which the same-origin gate refuses. That is how the connect broke live once,
 * past unit tests that set the Origin by hand.
 *
 * Google is played by recorded responses (tests/fixtures/connectors); no
 * request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, googleFetch, type GoogleWorld } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { listAccountStatus } from "../src/core/connectors/account-status.ts";
import { setAccountStatus } from "../src/core/connectors/accounts.ts";
import { openNotice } from "../src/core/connectors/sync-store.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import type { Storage } from "../src/core/storage.ts";

setDefaultTimeout(30_000);

const PUBLIC = "https://brain.example.test";
const HOST = "brain.example.test";
const BOOT = `boot-${randomBytes(12).toString("hex")}`;
const OWNER = "owner@example.test";
const ENV_KEYS = [
  "MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE",
  "MEMRAIN_GOOGLE_OAUTH_CLIENT_ID", "MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET", "MEMRAIN_HTTP_TRUST_PROXY",
] as const;

/** The SPA's fetch() from our own page. */
const SPA = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

interface Browser {
  base: string;
  cookie: string | null;
  /** A request the browser makes to the brain through the proxy. */
  send(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; withCookie?: boolean }): Promise<Response>;
}

function browser(port: number): Browser {
  const b: Browser = {
    base: `http://127.0.0.1:${port}`,
    cookie: null,
    send(path, init = {}) {
      const headers: Record<string, string> = { host: HOST, ...init.headers };
      if (init.withCookie !== false && b.cookie) headers.cookie = b.cookie;
      return fetch(`${b.base}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual" });
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

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin connect, end to end (${name})`, () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const realFetch = globalThis.fetch;
  let world: GoogleWorld;
  let server: ServerHandle | null = null;
  let db: { storage: Storage; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.MEMRAIN_CONNECTORS_ENABLED = "1";
    process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
    process.env.MEMRAIN_GOOGLE_OAUTH_CLIENT_ID = "env-client.apps.googleusercontent.com";
    process.env.MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET = "env-client-secret-value";
    world = { calls: [], events: () => "eventsFullPage2" };
    const google = googleFetch(world);
    // The server's provider calls go to the recorded Google; the browser's go to the server.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      return google(url, (init ?? {}) as Parameters<typeof google>[1]);
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
    expect(b.cookie).toMatch(/=[0-9a-f]{64}$/);
    return b;
  }

  async function connectGoogle(b: Browser, opts: { overridePolicy?: string } = {}): Promise<Response> {
    const started = await b.send("/admin/api/connectors/google/start", {
      method: "POST",
      headers: { ...SPA, origin: PUBLIC, "content-type": "application/json" },
      body: JSON.stringify({ source_id: "cal", services: ["calendar"] }),
    });
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { authorize_url: string }).authorize_url);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/admin/connectors/callback/google`);

    // Google sends the browser back: a cross-site navigation, so the
    // SameSite=Strict session cookie is not sent.
    const back = new URL(authorize.searchParams.get("redirect_uri")!);
    back.searchParams.set("state", authorize.searchParams.get("state")!);
    back.searchParams.set("code", "4/0test-auth-code");
    back.searchParams.set("scope", "email openid https://www.googleapis.com/auth/calendar.readonly");
    const page = await b.send(`${back.pathname}${back.search}`, {
      withCookie: false,
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", referer: "https://accounts.google.com/" },
    });
    expect(page.status).toBe(200);
    const { action, fields } = formFields(await page.text());
    expect(action).toBe("/admin/api/connectors/google/complete");

    // The owner clicks "Finish connecting": a same-origin form POST from that page.
    const origin = formPostOrigin(opts.overridePolicy ?? page.headers.get("referrer-policy"));
    return b.send(action, {
      method: "POST",
      headers: {
        origin, "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("connects, lists the account and picks its calendars, through every gate", async () => {
    const b = await boot();
    const before = await b.send("/admin/api/connectors", { headers: SPA });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ enabled: true, sources: expect.arrayContaining([{ id: "cal", kind: "calendar" }]) });

    const done = await connectGoogle(b);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/?connector=connected#connections");

    const listed = await b.send("/admin/api/connectors", { headers: SPA });
    const text = await listed.text();
    for (const secret of [GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, "env-client-secret-value"]) expect(text).not.toContain(secret);
    const { accounts } = JSON.parse(text) as { accounts: Array<Record<string, unknown> & { id: string }> };
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider: "google", source_id: "cal", account_label: OWNER, status: "active", enabled: false, needs_reconnect: false,
      last_run: null, grant_expiry: { state: "upcoming", days: 7, due_soon: false },
    });
    const id = accounts[0]!.id;

    const calendars = await b.send(`/admin/api/connectors/accounts/${id}/calendars`, { headers: SPA });
    expect(calendars.status).toBe(200);
    expect(await calendars.json()).toEqual({
      calendars: [
        { id: OWNER, summary: OWNER, primary: true, access_role: "owner", selected: true },
        { id: "team0abc123@group.calendar.google.com", summary: "Team", primary: false, access_role: "reader", selected: false },
      ],
      history_days: 90,
    });
    const saveInit = (origin: string) => ({
      method: "POST",
      headers: { ...SPA, origin, "content-type": "application/json" },
      body: JSON.stringify({ calendars: ["team0abc123@group.calendar.google.com"], history_days: 30 }),
    });
    // Another site cannot ride the session cookie to change what syncs.
    expect((await b.send(`/admin/api/connectors/accounts/${id}/calendars`, saveInit("https://evil.example.test"))).status).toBe(403);
    const saved = await b.send(`/admin/api/connectors/accounts/${id}/calendars`, saveInit(PUBLIC));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, calendars: ["team0abc123@group.calendar.google.com"], history_days: 30 });
    const again = await (await b.send(`/admin/api/connectors/accounts/${id}/calendars`, { headers: SPA })).json() as { calendars: Array<{ id: string; selected: boolean }>; history_days: number };
    expect(again.history_days).toBe(30);
    expect(again.calendars.find((c) => c.id === "team0abc123@group.calendar.google.com")?.selected).toBe(true);
  });

  it("a reconnect clears the waiting reconnect at once, before any sync runs", async () => {
    const b = await boot();
    expect((await connectGoogle(b)).status).toBe(303);
    const engine = db!.storage.engine();
    const [account] = await listAccountStatus(engine);
    // What the sync engine does when Google refuses the grant.
    await setAccountStatus(engine, account!.id, "needs_reconnect", "invalid_grant");
    await openNotice(engine, account!.id, "needs_reconnect", "token refresh refused (HTTP 400)");
    expect((await listAccountStatus(engine))[0]).toMatchObject({ needs_reconnect: true, state: "needs a reconnect" });

    expect((await connectGoogle(b)).status).toBe(303);
    // Sync is off, so no clean run will ever resolve the notice for it.
    expect((await listAccountStatus(engine))[0]).toMatchObject({ status: "active", needs_reconnect: false, state: "sync off" });
    const { notifications } = await (await b.send("/admin/api/notifications", { headers: SPA })).json() as { notifications: Array<{ kind: string; resolved_at: string | null }> };
    expect(notifications.filter((n) => n.kind === "needs_reconnect" && n.resolved_at === null)).toEqual([]);
  });

  it("a callback page served with no-referrer would make the browser post Origin: null, which the gate refuses", async () => {
    const b = await boot();
    const refused = await connectGoogle(b, { overridePolicy: "no-referrer" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Cross-origin request refused" });
    const { accounts } = await (await b.send("/admin/api/connectors", { headers: SPA })).json() as { accounts: unknown[] };
    expect(accounts).toEqual([]);
  });

  it("refuses the connector routes without a session, and a start posted from another site", async () => {
    const b = await boot();
    expect((await b.send("/admin/api/connectors", { headers: SPA, withCookie: false })).status).toBe(401);
    const crossSite = await b.send("/admin/api/connectors/google/start", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", origin: "https://evil.example.test", "content-type": "application/x-www-form-urlencoded" },
      body: "source_id=cal&services=calendar",
    });
    expect(crossSite.status).toBe(403);
    // A plain-http page on our own host is not us either.
    const http = await b.send("/admin/api/connectors/google/start", {
      method: "POST",
      headers: { ...SPA, origin: `http://${HOST}`, "content-type": "application/json" },
      body: JSON.stringify({ source_id: "cal", services: ["calendar"] }),
    });
    expect(http.status).toBe(403);
    expect(world.calls).toEqual([]);
  });
});
