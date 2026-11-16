/**
 * Saving a bring-your-own OAuth app the way the Connections page does: a
 * same-origin JSON POST from the browser through handleAdminApi's real gates
 * (admin session, same-origin check) with the shipped providers and connector
 * settings from the environment. The page reads back which providers take a
 * tenant and which can withdraw a grant on disconnect.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { listOAuthClients } from "../src/core/connectors/oauth-clients.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = "https://brain.example.test";
const KEYS = ["MEMRAIN_CONNECTORS_ENABLED", "MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE"] as const;
let saved: Array<readonly [string, string | undefined]> = [];

beforeEach(() => {
  saved = KEYS.map((k) => [k, process.env[k]] as const);
  delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
  process.env.MEMRAIN_CONNECTORS_ENABLED = "1";
  process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** What the page's fetch sends: same-origin, JSON, the session cookie (stood in for by requireAdmin). */
function browser(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, body === undefined
    ? { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } }
    : {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", ...headers },
        body: JSON.stringify(body),
      });
}

async function send(storage: Storage, req: Request): Promise<Response> {
  const res = await handleAdminApi(req, new URL(req.url), { storage, publicUrl: ORIGIN, requireAdmin: () => true, adminSessionId: () => "sess-byo" });
  if (res === null) throw new Error("route not handled");
  return res;
}

interface Report {
  providers: Array<{ id: string; auth: string; tenant_default: string | null; can_revoke: boolean; callback_uri: string | null }>;
  clients: Array<{ provider: string; client_id: string; tenant: string | null }>;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`own OAuth app over the admin API (${name})`, () => {
  it("saves an app from the page and lists it without its secret, with each provider's tenant and revoke facts", async () => {
    const db = await open();
    try {
      const res = await send(db.storage, browser("/admin/api/connectors/google/client", { client_id: "byo.apps.example.test", client_secret: "byo-secret-value-0123" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, provider: "google", client_id: "byo.apps.example.test" });

      const listed = await send(db.storage, browser("/admin/api/connectors"));
      const text = await listed.text();
      expect(text).not.toContain("byo-secret-value-0123");
      const report = JSON.parse(text) as Report;
      expect(report.clients.map((c) => [c.provider, c.client_id, c.tenant])).toEqual([["google", "byo.apps.example.test", null]]);
      const google = report.providers.find((p) => p.id === "google")!;
      expect(google).toMatchObject({ auth: "oauth", tenant_default: null, can_revoke: true, callback_uri: `${ORIGIN}/admin/connectors/callback/google` });
      // An API-key provider has no app of its own to name a tenant, and nothing to revoke here.
      expect(report.providers.find((p) => p.id === "fireflies")).toMatchObject({ auth: "api_key", tenant_default: null, can_revoke: false });
    } finally { await db.close(); }
  });

  it("refuses a tenant for a provider without tenants, and stores nothing", async () => {
    const db = await open();
    try {
      const res = await send(db.storage, browser("/admin/api/connectors/google/client", { client_id: "byo.apps.example.test", client_secret: "byo-secret-value-0123", tenant: "organizations" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "tenant_unsupported" });
      expect(await listOAuthClients(db.storage.engine())).toEqual([]);
    } finally { await db.close(); }
  });

  it("refuses the save from another site, and stores nothing", async () => {
    const db = await open();
    try {
      const res = await send(db.storage, browser("/admin/api/connectors/google/client",
        { client_id: "evil.apps.example.test", client_secret: "evil-secret-value-0123" },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
      expect(res.status).toBe(403);
      expect(await listOAuthClients(db.storage.engine())).toEqual([]);
    } finally { await db.close(); }
  });
});
