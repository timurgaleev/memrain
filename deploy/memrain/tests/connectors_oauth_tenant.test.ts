/**
 * A provider whose app decides who may sign in (Microsoft's `{tenant}` in the
 * authorize and token paths): the bring-your-own client carries its tenant,
 * the environment client reads MEMRAIN_<PROVIDER>_OAUTH_TENANT, and the
 * provider's default fills the path otherwise. The connect start, the code
 * exchange and the sync's token renewal all go to the same tenant.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, storeCredential } from "../src/core/connectors/accounts.ts";
import { getOAuthClient, listOAuthClients, setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { normalizeTenant, ProviderRegistry, type ConnectorProvider } from "../src/core/connectors/providers.ts";
import { completeConnect, ConnectError, connectorCallbackUri, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { connectorRuntime, toSyncAccount } from "../src/core/connectors/runtime.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { SyncAdapter } from "../src/core/connectors/sync-engine.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const kek = kekFromBytes(randomBytes(32));
const SESSION = "admin-session-id-tenant-aaaaaaaaaaaaaaaa";
const REDIRECT = connectorCallbackUri("https://brain.example.test", "dir");
const TENANT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function dirProvider(over: Partial<ConnectorProvider> = {}): ConnectorProvider {
  return {
    id: "dir",
    authorizeUrl: "https://login.provider.test/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.provider.test/{tenant}/oauth2/v2.0/token",
    tenant: { default: "common" },
    baseScopes: ["openid"],
    services: { mail: { scopes: ["mail.read"], sourceKinds: ["mailbox"] } },
    async identify({ fetch, accessToken }) {
      const res = await fetch("https://api.provider.test/me", { headers: { authorization: `Bearer ${accessToken}` } });
      return ((await res.json()) as { email: string }).email;
    },
    sync: { apiOrigin: "https://api.provider.test", adapter: () => ({}) as SyncAdapter },
    ...over,
  };
}

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(dirProvider());
  return r;
}

/** Plays the token and identity endpoints on any tenant path and records every call. */
function recorded(): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => {
    urls.push(url);
    if (/^https:\/\/login\.provider\.test\/[^/]+\/oauth2\/v2\.0\/token$/.test(url)) {
      return Response.json({ access_token: TEST_ACCESS_TOKEN, refresh_token: TEST_REFRESH_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "openid mail.read" });
    }
    if (url === "https://api.provider.test/me") return Response.json({ email: "owner@example.test" });
    return new Response("not found", { status: 404 });
  };
  return { fetch, urls };
}

function deps(e: Engine, fetch: FetchFn, env: NodeJS.ProcessEnv = {}): ConnectDeps {
  return { engine: e, kek, providers: registry(), fetch, env };
}

async function begin(d: ConnectDeps) {
  const started = await startConnect(d, {
    provider: "dir", sourceId: "inbox", services: ["mail"], principalRef: "admin:operator", adminSessionId: SESSION, redirectUri: REDIRECT,
  });
  const url = new URL(started.authorizeUrl);
  return { url, state: url.searchParams.get("state")! };
}

describe("tenant names", () => {
  it("accepts the three audiences, a directory id and a domain, in lower case", () => {
    expect(normalizeTenant("common")).toBe("common");
    expect(normalizeTenant(" Organizations ")).toBe("organizations");
    expect(normalizeTenant("consumers")).toBe("consumers");
    expect(normalizeTenant(TENANT_ID.toUpperCase())).toBe(TENANT_ID);
    expect(normalizeTenant("Contoso.onmicrosoft.com")).toBe("contoso.onmicrosoft.com");
  });

  it("refuses anything that could change the endpoint's path or host", () => {
    for (const bad of ["", "common/../evil", "a/b", "evil.example?x=1", "x#y", "contoso", "-bad.example", "a..b", "a b.example", `${"a".repeat(64)}.example`]) {
      expect(normalizeTenant(bad)).toBeNull();
    }
  });
});

describe("provider registry and tenants", () => {
  it("needs a declared tenant for a {tenant} endpoint, and the reverse", () => {
    const r = new ProviderRegistry();
    expect(() => r.register(dirProvider({ id: "undeclared", tenant: undefined }))).toThrow("tenant");
    expect(() => r.register(dirProvider({ id: "unused", authorizeUrl: "https://login.provider.test/authorize", tokenUrl: "https://login.provider.test/token" }))).toThrow("tenant");
    expect(() => r.register(dirProvider({ id: "baddefault", tenant: { default: "a/b" } }))).toThrow("tenant");
    r.register(dirProvider());
    expect(r.get("dir")?.tenant).toEqual({ default: "common" });
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`OAuth client tenants (${name})`, () => {
  it("stores, lists and replaces a client's tenant, and refuses a bad one", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await setOAuthClient(e, kek, "dir", "byo-client-id", "byo-client-secret", "Organizations");
      expect(await getOAuthClient(e, kek, "dir")).toEqual({ clientId: "byo-client-id", clientSecret: "byo-client-secret", tenant: "organizations" });
      expect((await listOAuthClients(e)).map((c) => [c.provider, c.client_id, c.tenant])).toEqual([["dir", "byo-client-id", "organizations"]]);

      await expect(setOAuthClient(e, kek, "dir", "byo-client-id", "byo-client-secret", "a/b")).rejects.toThrow("tenant");
      expect((await getOAuthClient(e, kek, "dir"))?.tenant).toBe("organizations");

      // A replacement without a tenant falls back to the provider's default, not the old app's tenant.
      await setOAuthClient(e, kek, "dir", "second-client-id", "second-client-secret");
      expect(await getOAuthClient(e, kek, "dir")).toEqual({ clientId: "second-client-id", clientSecret: "second-client-secret", tenant: null });
    } finally { await db.close(); }
  });

  it("starts and finishes a connect on the stored client's tenant", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
      await setOAuthClient(e, kek, "dir", "byo-client-id", "byo-client-secret", TENANT_ID);
      const fake = recorded();
      const d = deps(e, fake.fetch);
      const { url, state } = await begin(d);
      expect(`${url.origin}${url.pathname}`).toBe(`https://login.provider.test/${TENANT_ID}/oauth2/v2.0/authorize`);
      await completeConnect(d, { provider: "dir", state, code: "c", adminSessionId: SESSION });
      expect(fake.urls[0]).toBe(`https://login.provider.test/${TENANT_ID}/oauth2/v2.0/token`);
    } finally { await db.close(); }
  });

  it("uses the provider default, or the environment's tenant for the environment's client", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
      const env = { MEMRAIN_DIR_OAUTH_CLIENT_ID: "env-client-id", MEMRAIN_DIR_OAUTH_CLIENT_SECRET: "env-client-secret" };
      const plain = await begin(deps(e, recorded().fetch, env));
      expect(plain.url.pathname).toBe("/common/oauth2/v2.0/authorize");
      const consumers = await begin(deps(e, recorded().fetch, { ...env, MEMRAIN_DIR_OAUTH_TENANT: "consumers" }));
      expect(consumers.url.pathname).toBe("/consumers/oauth2/v2.0/authorize");
      const err = await begin(deps(e, recorded().fetch, { ...env, MEMRAIN_DIR_OAUTH_TENANT: "../evil" })).catch((x: unknown) => x);
      expect(err instanceof ConnectError ? err.code : String(err)).toBe("invalid_tenant");
    } finally { await db.close(); }
  });

  it("renews a sync's access token on the stored client's tenant", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
      await setOAuthClient(e, kek, "dir", "byo-client-id", "byo-client-secret", "organizations");
      const created = await createAccount(e, { sourceId: "inbox", provider: "dir", services: ["mail"], principalRef: "admin:operator", accountLabel: "owner@example.test" });
      await storeCredential(e, kek, created, { access_token: "stale-access-token-0000", refresh_token: "old-refresh-token-0000" },
        { scopes: ["openid", "mail.read"], expiresAt: new Date(Date.now() - 60_000) });
      const fake = recorded();
      const runtime = connectorRuntime(db.storage, { kek, providers: registry(), fetch: fake.fetch, env: {} });
      const account = await getAccount(e, created.id);
      const source = await runtime.depsFor(toSyncAccount(account!)).tokenSource(toSyncAccount(account!), () => {});
      expect(await source.token()).toBe(TEST_ACCESS_TOKEN);
      expect(fake.urls).toEqual(["https://login.provider.test/organizations/oauth2/v2.0/token"]);
    } finally { await db.close(); }
  });
});
