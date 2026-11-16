/**
 * The admin route that saves a provider API key (Fireflies): the key is
 * checked with the provider, sealed in the vault, and never echoed back in any
 * answer; the route stays closed while connectors are off and refuses an
 * OAuth provider, a malformed key and an unknown source without a request
 * leaving the process.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { FIREFLIES_KEY, firefliesFetch } from "./helpers/fireflies-recorded.ts";
import { testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { firefliesProvider } from "../src/core/connectors/fireflies.ts";
import { listAccounts, readCredential } from "../src/core/connectors/accounts.ts";
import { handleAdminConnectors, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = "https://brain.example.test";
const kek = kekFromBytes(randomBytes(32));

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(testProvider("test"));
  r.registerApiKey(firefliesProvider());
  return r;
}

function deps(storage: Storage, fetch: FetchFn, extra: Partial<AdminConnectorDeps> = {}): AdminConnectorDeps {
  return {
    storage,
    publicUrl: ORIGIN,
    adminSessionId: () => "sess-1",
    status: () => ({ enabled: true, kekId: kek.id, reason: null }),
    kek: () => kek,
    providers: registry(),
    fetch,
    ...extra,
  };
}

const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(req: Request, d: AdminConnectorDeps): Promise<Response> {
  const res = await handleAdminConnectors(req, new URL(req.url), d);
  if (!res) throw new Error("route not handled");
  return res;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin connector key route (${name})`, () => {
  it("saves a verified key sealed, answers without it, and lists the provider as api_key", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "meet", kind: "meeting", pathPrefix: "meeting/" });
      const fake = firefliesFetch({ user: () => "user" });
      const d = deps(db.storage, fake.fetch);
      const res = await call(post("/admin/api/connectors/fireflies/key", { source_id: "meet", api_key: FIREFLIES_KEY }), d);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const text = await res.text();
      expect(text).not.toContain(FIREFLIES_KEY);
      const body = JSON.parse(text) as { ok: boolean; reconnected: boolean; account: Record<string, unknown> };
      expect(body).toMatchObject({ ok: true, reconnected: false, account: { provider: "fireflies", account_label: "owner@example.com", enabled: false, status: "active" } });
      const [account] = await listAccounts(e);
      expect((await readCredential(e, kek, account!.id))?.tokens.access_token).toBe(FIREFLIES_KEY);

      const listed = await call(new Request(`${ORIGIN}/admin/api/connectors`), d);
      const listedText = await listed.text();
      expect(listedText).not.toContain(FIREFLIES_KEY);
      expect((JSON.parse(listedText) as { providers: unknown[] }).providers).toContainEqual({
        id: "fireflies", services: ["fireflies"], service_kinds: { fireflies: ["meeting"] }, auth: "api_key", callback_uri: null,
        tenant_default: null, can_revoke: false, consent_urls: [], client_rejected: null,
      });
    } finally { await db.close(); }
  });

  it("stays closed while connectors are off and sends nothing", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "meet", kind: "meeting", pathPrefix: "meeting/" });
      const fake = firefliesFetch({ user: () => "user" });
      const off = deps(db.storage, fake.fetch, { status: () => ({ enabled: false, kekId: null, reason: "connectors are off" }), kek: () => null });
      const res = await call(post("/admin/api/connectors/fireflies/key", { source_id: "meet", api_key: FIREFLIES_KEY }), off);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "connectors_disabled", reason: "connectors are off" });
      expect(fake.requests).toEqual([]);
    } finally { await db.close(); }
  });

  it("refuses an OAuth provider, a malformed key, a missing key and an unknown source", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "meet", kind: "meeting", pathPrefix: "meeting/" });
      const fake = firefliesFetch({ user: () => "user" });
      const d = deps(db.storage, fake.fetch);
      const errorOf = async (path: string, body: unknown) => {
        const res = await call(post(path, body), d);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).not.toContain(FIREFLIES_KEY);
        return (JSON.parse(text) as { error: string }).error;
      };
      expect(await errorOf("/admin/api/connectors/test/key", { source_id: "meet", api_key: FIREFLIES_KEY })).toBe("unknown_provider");
      expect(await errorOf("/admin/api/connectors/fireflies/key", { source_id: "meet", api_key: "short" })).toBe("key_invalid");
      expect(await errorOf("/admin/api/connectors/fireflies/key", { source_id: "meet" })).toBe("key_invalid");
      expect(await errorOf("/admin/api/connectors/fireflies/key", { source_id: "nowhere", api_key: FIREFLIES_KEY })).toBe("source_not_found");
      expect(fake.requests).toEqual([]);
    } finally { await db.close(); }
  });

  it("says the key was rejected, and that the provider was unreachable, without the key", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "meet", kind: "meeting", pathPrefix: "meeting/" });
      const rejected = await call(post("/admin/api/connectors/fireflies/key", { source_id: "meet", api_key: FIREFLIES_KEY }),
        deps(db.storage, firefliesFetch({ user: () => "user" }, "a-different-key-value").fetch));
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "key_rejected" });
      const down = await call(post("/admin/api/connectors/fireflies/key", { source_id: "meet", api_key: FIREFLIES_KEY }),
        deps(db.storage, async () => { throw new Error(`connect ECONNREFUSED ${FIREFLIES_KEY}`); }));
      expect(down.status).toBe(502);
      expect(await down.text()).not.toContain(FIREFLIES_KEY);
      expect(await listAccounts(db.storage.engine())).toEqual([]);
    } finally { await db.close(); }
  });
});
