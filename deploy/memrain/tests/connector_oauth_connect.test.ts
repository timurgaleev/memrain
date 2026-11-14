import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fakeProvider, TEST_ACCESS_TOKEN, TEST_REFRESH_TOKEN, testProvider } from "./helpers/connector-test-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, readCredential, setAccountEnabled, markNeedsReconnect, credentialMeta } from "../src/core/connectors/accounts.ts";
import { setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import {
  completeConnect,
  ConnectError,
  connectorCallbackUri,
  disconnectAccount,
  startConnect,
  type ConnectDeps,
} from "../src/core/connectors/oauth-connect.ts";
import { createTokenProvider, refreshLockId } from "../src/core/connectors/token-provider.ts";
import { vaultCredentialStore } from "../src/core/connectors/runtime.ts";
import { acquireWorkerLock } from "../src/core/jobs/worker-lock.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";

const kek = kekFromBytes(randomBytes(32));
const SESSION = "admin-session-id-aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SESSION = "admin-session-id-bbbbbbbbbbbbbbbbbbbbbbbb";
const ENV = { MEMRAIN_TEST_OAUTH_CLIENT_ID: "env-client-id", MEMRAIN_TEST_OAUTH_CLIENT_SECRET: "env-client-secret-value" };
const REDIRECT = connectorCallbackUri("https://brain.example.test", "test");

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(testProvider("test"));
  r.register(testProvider("other"));
  return r;
}

function deps(e: Engine, fetch: FetchFn, extra: Partial<ConnectDeps> = {}): ConnectDeps {
  return { engine: e, kek, providers: registry(), fetch, env: ENV, ...extra };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof ConnectError ? e.code : `other: ${String(e)}`;
  }
}

async function begin(e: Engine, d: ConnectDeps, services = ["mail"]) {
  const started = await startConnect(d, {
    provider: "test", sourceId: "inbox", services, principalRef: "admin:operator", adminSessionId: SESSION, redirectUri: REDIRECT,
  });
  const url = new URL(started.authorizeUrl);
  return { url, state: url.searchParams.get("state")! };
}

const rowCount = async (e: Engine, table: string) =>
  Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector OAuth connect (${name})`, () => {
  it("starts with PKCE S256 and keeps only hashes and a sealed verifier", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const { url, state } = await begin(e, deps(e, fakeProvider().fetch));
      expect(url.origin + url.pathname).toBe("https://auth.provider.test/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("env-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("https://brain.example.test/admin/connectors/callback/test");
      expect(url.searchParams.get("scope")).toBe("openid mail.read");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(state).toMatch(/^[\w-]{43}$/);
      const rows = await e.query<Record<string, unknown>>(`SELECT * FROM connector_oauth_states`);
      expect(rows.rows.length).toBe(1);
      const dump = JSON.stringify(rows.rows);
      expect(dump).not.toContain(state);
      expect(dump).not.toContain(SESSION);
      expect(dump).not.toContain("env-client-secret-value");
    } finally { await db.close(); }
  });

  it("refuses to start without a key, client, known provider, service or matching source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await registerSource(e, { id: "notes", kind: "vault", pathPrefix: "/notes" });
      const f = fakeProvider().fetch;
      const base = { provider: "test", sourceId: "inbox", services: ["mail"], principalRef: "admin:operator", adminSessionId: SESSION, redirectUri: REDIRECT };
      expect(await code(startConnect(deps(e, f, { kek: null }), base))).toBe("connectors_disabled");
      expect(await code(startConnect(deps(e, f, { env: {} }), base))).toBe("no_client");
      expect(await code(startConnect(deps(e, f), { ...base, provider: "nope" }))).toBe("unknown_provider");
      expect(await code(startConnect(deps(e, f), { ...base, services: ["drive"] }))).toBe("unknown_service");
      expect(await code(startConnect(deps(e, f), { ...base, services: [] }))).toBe("unknown_service");
      expect(await code(startConnect(deps(e, f), { ...base, sourceId: "missing" }))).toBe("source_not_found");
      expect(await code(startConnect(deps(e, f), { ...base, sourceId: "notes" }))).toBe("source_kind");
      expect(await code(startConnect(deps(e, f), { ...base, adminSessionId: "" }))).toBe("state_session");
      expect(await code(startConnect(deps(e, f), { ...base, redirectUri: "http://brain.example.test/cb" }))).toBe("redirect_uri");
      expect(await rowCount(e, "connector_oauth_states")).toBe(0);
    } finally { await db.close(); }
  });

  it("completes: exchanges the code with the verifier and creates a disabled account", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { url, state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "auth-code-1", adminSessionId: SESSION });
      expect(done.reconnected).toBe(false);
      expect(done.account).toMatchObject({ provider: "test", source_id: "inbox", account_label: "owner@example.test", enabled: false, status: "active", services: ["mail"], principal_ref: "admin:operator" });
      expect(JSON.stringify(done)).not.toContain(TEST_ACCESS_TOKEN);

      const tokenCall = fake.calls.find((c) => c.url === "https://auth.provider.test/token")!;
      expect(tokenCall.method).toBe("POST");
      expect(tokenCall.body?.get("grant_type")).toBe("authorization_code");
      expect(tokenCall.body?.get("code")).toBe("auth-code-1");
      expect(tokenCall.body?.get("redirect_uri")).toBe(REDIRECT);
      const verifier = tokenCall.body!.get("code_verifier")!;
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);

      const cred = await readCredential(e, kek, done.account.id);
      expect(cred).toMatchObject({ tokens: { access_token: TEST_ACCESS_TOKEN, refresh_token: TEST_REFRESH_TOKEN }, scopes: ["mail.read", "openid"] });
      expect(cred?.expiresAt).not.toBeNull();
    } finally { await db.close(); }
  });

  it("uses a state once: a replay is refused", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const d = deps(e, fakeProvider().fetch);
      const { state } = await begin(e, d);
      await completeConnect(d, { provider: "test", state, code: "c1", adminSessionId: SESSION });
      expect(await code(completeConnect(d, { provider: "test", state, code: "c2", adminSessionId: SESSION }))).toBe("state_used");
      expect(await code(completeConnect(d, { provider: "test", state: "x".repeat(43), code: "c", adminSessionId: SESSION }))).toBe("state_invalid");
      expect(await code(completeConnect(d, { provider: "test", state: "short", code: "c", adminSessionId: SESSION }))).toBe("state_invalid");
    } finally { await db.close(); }
  });

  it("refuses a state started by another admin session, and burns it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      expect(await code(completeConnect(d, { provider: "test", state, code: "attacker-code", adminSessionId: OTHER_SESSION }))).toBe("state_session");
      expect(fake.calls.some((c) => c.url.endsWith("/token"))).toBe(false);
      expect(await code(completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION }))).toBe("state_used");
      expect(await rowCount(e, "connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  it("refuses an expired state and a state for another provider", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      let now = Date.parse("2026-11-14T10:00:00Z");
      const d = deps(e, fakeProvider().fetch, { now: () => now });
      const expired = await begin(e, d);
      now += 11 * 60_000;
      expect(await code(completeConnect(d, { provider: "test", state: expired.state, code: "c", adminSessionId: SESSION }))).toBe("state_expired");
      const fresh = await begin(e, d);
      expect(await code(completeConnect(d, { provider: "other", state: fresh.state, code: "c", adminSessionId: SESSION }))).toBe("state_provider");
    } finally { await db.close(); }
  });

  it("refuses and revokes a grant with an extra write scope, storing nothing", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider({ grantedScope: "openid mail.read mail.send" });
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      let err: unknown;
      try {
        await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      } catch (x) { err = x; }
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("scope_mismatch");
      expect((err as ConnectError).detail).toEqual({ extra: ["mail.send"], missing: [], revoked: true });
      expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain(TEST_ACCESS_TOKEN);
      const revoke = fake.calls.find((c) => c.url === "https://auth.provider.test/revoke");
      expect(revoke?.body?.get("token")).toBe(TEST_REFRESH_TOKEN);
      expect(await rowCount(e, "connector_accounts")).toBe(0);
      expect(await rowCount(e, "connector_credentials")).toBe(0);
    } finally { await db.close(); }
  });

  it("revokes the fresh grant when storing the account fails, leaving nothing behind", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await e.exec(`
        CREATE FUNCTION test_refuse_credential() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'storage unavailable'; END $$;
        CREATE TRIGGER test_refuse_credential BEFORE INSERT ON connector_credentials
          FOR EACH ROW EXECUTE FUNCTION test_refuse_credential();`);
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      await expect(completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION })).rejects.toThrow("storage unavailable");
      expect(fake.calls.filter((c) => c.url.endsWith("/revoke")).map((c) => c.body?.get("token"))).toEqual([TEST_REFRESH_TOKEN]);
      expect(await rowCount(e, "connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  it("refuses a grant missing a requested scope, and accepts an omitted scope field as the request", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const narrow = deps(e, fakeProvider({ grantedScope: "openid" }).fetch);
      const first = await begin(e, narrow);
      expect(await code(completeConnect(narrow, { provider: "test", state: first.state, code: "c", adminSessionId: SESSION }))).toBe("scope_mismatch");
      const omitted = deps(e, fakeProvider({ grantedScope: null }).fetch);
      const second = await begin(e, omitted);
      const done = await completeConnect(omitted, { provider: "test", state: second.state, code: "c", adminSessionId: SESSION });
      expect((await credentialMeta(e, done.account.id))?.scopes).toEqual(["mail.read", "openid"]);
    } finally { await db.close(); }
  });

  it("turns a provider error or a failed exchange into a code, without echoing provider text", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const d = deps(e, fakeProvider().fetch);
      const denied = await begin(e, d);
      let err: unknown;
      try {
        await completeConnect(d, { provider: "test", state: denied.state, error: "access_denied<script>", adminSessionId: SESSION });
      } catch (x) { err = x; }
      expect((err as ConnectError).code).toBe("provider_denied");
      expect((err as Error).message).not.toContain("<script>");
      expect(await code(completeConnect(d, { provider: "test", state: denied.state, code: "c", adminSessionId: SESSION }))).toBe("state_used");

      const failing = deps(e, fakeProvider({ tokenStatus: 400 }).fetch);
      const bad = await begin(e, failing);
      try {
        await completeConnect(failing, { provider: "test", state: bad.state, code: "secret-code-value", adminSessionId: SESSION });
      } catch (x) { err = x; }
      expect((err as ConnectError).code).toBe("token_exchange");
      expect((err as Error).message).not.toContain("secret-code-value");
    } finally { await db.close(); }
  });

  it("reconnects an existing account in place, keeping its id and settings", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const d = deps(e, fakeProvider().fetch);
      const first = await begin(e, d);
      const created = await completeConnect(d, { provider: "test", state: first.state, code: "c", adminSessionId: SESSION });
      await setAccountEnabled(e, created.account.id, true);
      await markNeedsReconnect(e, created.account.id, "invalid_grant");
      const again = await begin(e, d);
      const re = await completeConnect(d, { provider: "test", state: again.state, code: "c", adminSessionId: SESSION });
      expect(re.reconnected).toBe(true);
      expect(re.account.id).toBe(created.account.id);
      expect(re.account).toMatchObject({ status: "active", status_reason: null, enabled: true });
      expect(await rowCount(e, "connector_accounts")).toBe(1);
    } finally { await db.close(); }
  });

  it("prefers a stored bring-your-own client over the environment", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await setOAuthClient(e, kek, "test", "byo-client-id", "byo-client-secret");
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { url, state } = await begin(e, d);
      expect(url.searchParams.get("client_id")).toBe("byo-client-id");
      await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      const tokenCall = fake.calls.find((c) => c.url.endsWith("/token"))!;
      expect(tokenCall.body?.get("client_id")).toBe("byo-client-id");
      expect(tokenCall.body?.get("client_secret")).toBe("byo-client-secret");
    } finally { await db.close(); }
  });

  it("disconnects: revokes upstream, drops the credential, keeps the account row", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      await setAccountEnabled(e, done.account.id, true);
      expect(await disconnectAccount(d, done.account.id)).toEqual({ revoked: true, credentialKept: false });
      expect(fake.calls.filter((c) => c.url.endsWith("/revoke")).map((c) => c.body?.get("token"))).toEqual([TEST_REFRESH_TOKEN]);
      expect(await credentialMeta(e, done.account.id)).toBeNull();
      expect(await getAccount(e, done.account.id)).toMatchObject({ status: "revoked", enabled: false });
    } finally { await db.close(); }
  });

  it("keeps the sealed credential when upstream revocation fails, unless forced", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider({ revokeStatus: 503 });
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      await setAccountEnabled(e, done.account.id, true);
      expect(await disconnectAccount(d, done.account.id)).toEqual({ revoked: false, credentialKept: true });
      expect(await credentialMeta(e, done.account.id)).not.toBeNull();
      expect(await getAccount(e, done.account.id)).toMatchObject({ status: "error", status_reason: "revoke_failed", enabled: false });

      const noKey = deps(e, fake.fetch, { kek: null });
      expect(await disconnectAccount(noKey, done.account.id)).toEqual({ revoked: false, credentialKept: true });

      expect(await disconnectAccount(d, done.account.id, { force: true })).toEqual({ revoked: false, credentialKept: false });
      expect(await credentialMeta(e, done.account.id)).toBeNull();
      expect(await getAccount(e, done.account.id)).toMatchObject({ status: "revoked", enabled: false });
    } finally { await db.close(); }
  });

  it("waits for a refresh in flight and revokes the refresh token it rotated to", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      await setAccountEnabled(e, done.account.id, true);

      // Assembled at run time: a token shape must not sit in the source.
      const rotated = ["rotated", "refresh", "token", "value"].join("-");
      let entered!: () => void;
      const inside = new Promise<void>((r) => { entered = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const tokens = createTokenProvider({
        engine: e,
        accountId: done.account.id,
        store: vaultCredentialStore(e, kek),
        refresh: async () => {
          entered();
          await gate;
          return { accessToken: "rotated-access", refreshToken: rotated, expiresInSec: 3600 };
        },
      });
      const refreshing = tokens.refresh(TEST_ACCESS_TOKEN);
      await inside;
      const disconnecting = disconnectAccount(d, done.account.id);
      await new Promise((r) => setTimeout(r, 50));
      release();
      await Promise.allSettled([refreshing]);
      expect(await disconnecting).toEqual({ revoked: true, credentialKept: false });
      // The token the provider holds now is the rotated one; revoking the old one would leave it live.
      expect(fake.calls.filter((c) => c.url.endsWith("/revoke")).map((c) => c.body?.get("token"))).toEqual([rotated]);
      expect(await credentialMeta(e, done.account.id)).toBeNull();
    } finally { await db.close(); }
  });

  it("keeps the credential when its refresh lock was lost while the revoke ran", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const providers = new ProviderRegistry();
      let accountId = "";
      providers.register({
        ...testProvider("test"),
        // A revoke slow enough that the lock lapsed and a refresh took it over.
        revoke: async () => {
          await e.query(`UPDATE worker_lock SET holder = 'refresh-worker' WHERE id = $1`, [refreshLockId(accountId)]);
          return true;
        },
      });
      const d = deps(e, fake.fetch, { providers });
      const { state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      accountId = done.account.id;
      expect(await disconnectAccount(d, done.account.id)).toEqual({ revoked: false, credentialKept: true });
      expect(await credentialMeta(e, done.account.id)).not.toBeNull();
      expect(await getAccount(e, done.account.id)).toMatchObject({ status: "error", status_reason: "revoke_failed", enabled: false });
    } finally { await db.close(); }
  });

  it("refuses to disconnect while another worker keeps refreshing past the wait", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const fake = fakeProvider();
      const d = deps(e, fake.fetch);
      const { state } = await begin(e, d);
      const done = await completeConnect(d, { provider: "test", state, code: "c", adminSessionId: SESSION });
      expect(await acquireWorkerLock(e, refreshLockId(done.account.id), "other-worker", 60)).toBe(true);
      expect(await code(disconnectAccount(d, done.account.id, { waitMs: 0 }))).toBe("refresh_in_progress");
      expect(fake.calls.filter((c) => c.url.endsWith("/revoke"))).toEqual([]);
      expect(await credentialMeta(e, done.account.id)).not.toBeNull();
    } finally { await db.close(); }
  });
});

describe("connector callback URI", () => {
  it("is built from the configured public origin only", () => {
    expect(connectorCallbackUri("https://brain.example.test/", "test")).toBe("https://brain.example.test/admin/connectors/callback/test");
    expect(connectorCallbackUri("http://localhost:8787", "test")).toBe("http://localhost:8787/admin/connectors/callback/test");
    expect(() => connectorCallbackUri("http://brain.example.test", "test")).toThrow();
    expect(() => connectorCallbackUri("https://brain.example.test", "Bad/Name")).toThrow();
  });
});

describe("provider registry", () => {
  it("refuses a provider with a non-https endpoint or a duplicate id", () => {
    const r = new ProviderRegistry();
    r.register(testProvider("test"));
    expect(() => r.register(testProvider("test"))).toThrow("already");
    expect(() => r.register({ ...testProvider("plain"), tokenUrl: "http://auth.provider.test/token" })).toThrow("https");
    expect(r.list().map((p) => p.id)).toEqual(["test"]);
  });
});
