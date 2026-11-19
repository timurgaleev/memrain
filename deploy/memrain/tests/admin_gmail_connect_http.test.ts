/**
 * Starting a Gmail connect the way the Connections page does: a same-origin
 * JSON POST from the browser through handleAdminApi's real gates (admin
 * session, same-origin check) with the shipped providers and connector
 * settings from the environment. Gmail goes into a mailbox source and asks
 * for gmail.readonly; next to a connected calendar it asks for both scopes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount, storeCredential } from "../src/core/connectors/accounts.ts";
import { loadKek } from "../src/core/connectors/vault.ts";
import { GOOGLE_CALENDAR_READONLY, GOOGLE_GMAIL_READONLY } from "../src/core/connectors/google/provider.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = "https://brain.example.test";
const KEYS = ["MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_GOOGLE_OAUTH_CLIENT_ID", "MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET"] as const;
let saved: Array<readonly [string, string | undefined]> = [];

beforeEach(() => {
  saved = KEYS.map((k) => [k, process.env[k]] as const);
  delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
  process.env.MEMRAIN_CONNECTORS_ENABLED = "1";
  process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
  process.env.MEMRAIN_GOOGLE_OAUTH_CLIENT_ID = "env-client.apps.googleusercontent.com";
  process.env.MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET = "env-client-secret-value";
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** What the page's fetch sends: same-origin, JSON, the session cookie (stood in for by requireAdmin). */
function browserPost(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    body: JSON.stringify(body),
  });
}

async function start(storage: Storage, sourceId: string): Promise<Response> {
  const req = browserPost("/admin/api/connectors/google/start", { source_id: sourceId, services: ["gmail"] });
  const res = await handleAdminApi(req, new URL(req.url), { storage, publicUrl: ORIGIN, requireAdmin: () => true, adminSessionId: () => "sess-gmail" });
  if (res === null) throw new Error("route not handled");
  return res;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail connect over the admin API (${name})`, () => {
  it("starts a Gmail connect into a mailbox source and refuses a calendar source", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "me-mail", kind: "mailbox", pathPrefix: "mail/" });
      await registerSource(e, { id: "me-calendar", kind: "calendar", pathPrefix: "calendar/" });
      const ok = await start(db.storage, "me-mail");
      expect(ok.status).toBe(200);
      const url = new URL(((await ok.json()) as { authorize_url: string }).authorize_url);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_GMAIL_READONLY}`);
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/admin/connectors/callback/google`);

      const wrong = await start(db.storage, "me-calendar");
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toEqual({ error: "source_kind" });
    } finally { await db.close(); }
  });

  it("asks for calendar.readonly too when a Google calendar is already connected", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "me-mail", kind: "mailbox", pathPrefix: "mail/" });
      await registerSource(e, { id: "me-calendar", kind: "calendar", pathPrefix: "calendar/" });
      const cal = await createAccount(e, { sourceId: "me-calendar", provider: "google", services: ["calendar"], principalRef: "admin:operator", accountLabel: "owner@example.test" });
      await storeCredential(e, loadKek().kek!, cal, { access_token: "at", refresh_token: "rt" }, { scopes: ["email", GOOGLE_CALENDAR_READONLY, "openid"], expiresAt: null });
      const res = await start(db.storage, "me-mail");
      expect(res.status).toBe(200);
      const url = new URL(((await res.json()) as { authorize_url: string }).authorize_url);
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`);
    } finally { await db.close(); }
  });

  it("refuses the start from another origin", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "me-mail", kind: "mailbox", pathPrefix: "mail/" });
      const req = new Request(`${ORIGIN}/admin/api/connectors/google/start`, {
        method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ source_id: "me-mail", services: ["gmail"] }),
      });
      const res = await handleAdminApi(req, new URL(req.url), { storage: db.storage, publicUrl: ORIGIN, requireAdmin: () => true, adminSessionId: () => "s" });
      expect(res?.status).toBe(403);
    } finally { await db.close(); }
  });
});
