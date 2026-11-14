/**
 * The refreshing token source on both engines: an expiring token is renewed
 * before use, a rotated refresh token is stored, a refused refresh means a
 * reconnect and leaves the stored credential alone, and two racing refreshes
 * (two calls in one process, or another worker holding the refresh lock)
 * spend the refresh token once. Plus the OAuth token-endpoint call itself.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import {
  createTokenProvider,
  tokenEndpointRefresh,
  type CredentialStore,
  type RefreshResult,
  type StoredCredential,
} from "../src/core/connectors/token-provider.ts";
import { ReauthRequiredError } from "../src/core/connectors/types.ts";
import { acquireWorkerLock, releaseWorkerLock } from "../src/core/jobs/worker-lock.ts";
import { fakeClock, replay, type Recorded } from "./github-recorded.ts";

const ACCOUNT = "0b6a8f0e-1c2d-4e3f-8a9b-1c2d3e4f5a6b";
// Assembled at run time: a token shape must not sit in the source.
const tok = (name: string) => ["tk", name, "value"].join("-");

function memoryStore(initial: StoredCredential | null) {
  let cred = initial;
  const writes: StoredCredential[] = [];
  const store: CredentialStore = {
    read: async () => (cred === null ? null : { ...cred }),
    write: async (_id, next) => {
      writes.push({ ...next });
      cred = { ...next };
    },
  };
  return { store, writes, current: () => cred };
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`token provider (${name})`, () => {
  it("returns a fresh stored token without refreshing", async () => {
    const db = await open();
    try {
      const clock = fakeClock();
      const { store } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: new Date(clock.now() + 3_600_000) });
      let calls = 0;
      const p = createTokenProvider({ engine: db.storage.engine(), accountId: ACCOUNT, store, refresh: async () => { calls++; return { accessToken: "x" }; }, now: clock.now });
      expect(await p.token()).toBe(tok("a1"));
      expect(calls).toBe(0);
    } finally { await db.close(); }
  });

  it("renews a token inside the expiry margin and stores the rotated refresh token", async () => {
    const db = await open();
    try {
      const clock = fakeClock();
      const { store, current } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: new Date(clock.now() + 30_000) });
      const seen: string[] = [];
      const p = createTokenProvider({
        engine: db.storage.engine(), accountId: ACCOUNT, store, now: clock.now,
        refresh: async (rt): Promise<RefreshResult> => { seen.push(rt); return { accessToken: tok("a2"), refreshToken: tok("r2"), expiresInSec: 3600 }; },
      });
      expect(await p.token()).toBe(tok("a2"));
      expect(seen).toEqual([tok("r1")]);
      expect(current()).toEqual({ accessToken: tok("a2"), refreshToken: tok("r2"), expiresAt: new Date(clock.now() + 3_600_000) });
    } finally { await db.close(); }
  });

  it("tells its owner every token it reads or renews, refresh tokens included", async () => {
    const db = await open();
    try {
      const { store } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      const secrets = new Set<string>();
      const p = createTokenProvider({
        engine: db.storage.engine(), accountId: ACCOUNT, store, onSecret: (v) => void secrets.add(v),
        refresh: async () => ({ accessToken: tok("a2"), refreshToken: tok("r2"), expiresInSec: 3600 }),
      });
      expect(await p.token()).toBe(tok("a1"));
      expect([...secrets].sort()).toEqual([tok("a1"), tok("r1")].sort());
      await p.refresh(tok("a1"));
      expect([...secrets].sort()).toEqual([tok("a1"), tok("a2"), tok("r1"), tok("r2")].sort());
    } finally { await db.close(); }
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const db = await open();
    try {
      const { store, current } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      const p = createTokenProvider({ engine: db.storage.engine(), accountId: ACCOUNT, store, refresh: async () => ({ accessToken: tok("a2") }) });
      expect(await p.refresh(tok("a1"))).toBe(tok("a2"));
      expect(current()!.refreshToken).toBe(tok("r1"));
    } finally { await db.close(); }
  });

  it("turns a refused refresh into a reconnect and leaves the stored credential untouched", async () => {
    const db = await open();
    try {
      const { store, writes } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      const p = createTokenProvider({ engine: db.storage.engine(), accountId: ACCOUNT, store, refresh: async () => { throw new ReauthRequiredError("invalid_grant"); } });
      await expect(p.refresh(tok("a1"))).rejects.toBeInstanceOf(ReauthRequiredError);
      expect(writes).toEqual([]);
    } finally { await db.close(); }
  });

  it("needs a reconnect when there is no credential or no refresh token", async () => {
    const db = await open();
    try {
      const none = createTokenProvider({ engine: db.storage.engine(), accountId: ACCOUNT, store: memoryStore(null).store, refresh: async () => ({ accessToken: "x" }) });
      await expect(none.token()).rejects.toBeInstanceOf(ReauthRequiredError);
      const noRefresh = createTokenProvider({ engine: db.storage.engine(), accountId: ACCOUNT, store: memoryStore({ accessToken: tok("a1"), refreshToken: null, expiresAt: null }).store, refresh: async () => ({ accessToken: "x" }) });
      await expect(noRefresh.refresh(tok("a1"))).rejects.toBeInstanceOf(ReauthRequiredError);
    } finally { await db.close(); }
  });

  it("spends the refresh token once for two concurrent refreshes in one process", async () => {
    const db = await open();
    try {
      const { store } = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      let calls = 0;
      const p = createTokenProvider({
        engine: db.storage.engine(), accountId: ACCOUNT, store,
        refresh: async () => { calls++; await Bun.sleep(5); return { accessToken: tok("a2"), refreshToken: tok("r2") }; },
      });
      const [x, y] = await Promise.all([p.refresh(tok("a1")), p.refresh(tok("a1"))]);
      expect([x, y]).toEqual([tok("a2"), tok("a2")]);
      expect(calls).toBe(1);
    } finally { await db.close(); }
  });

  it("spends the refresh token once for two providers of one account that name the same worker", async () => {
    const db = await open();
    try {
      const mem = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      let calls = 0;
      const make = () => createTokenProvider({
        engine: db.storage.engine(), accountId: ACCOUNT, store: mem.store, holder: "worker-1",
        refresh: async () => { calls++; await Bun.sleep(30); return { accessToken: tok("a2"), refreshToken: tok("r2") }; },
        sleep: (ms) => Bun.sleep(Math.min(ms, 10)),
      });
      const [x, y] = await Promise.all([make().refresh(tok("a1")), make().refresh(tok("a1"))]);
      expect([x, y]).toEqual([tok("a2"), tok("a2")]);
      expect(calls).toBe(1);
    } finally { await db.close(); }
  });

  it("waits for another worker's refresh and uses its token instead of spending the refresh token again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const mem = memoryStore({ accessToken: tok("a1"), refreshToken: tok("r1"), expiresAt: null });
      expect(await acquireWorkerLock(e, `connector-refresh:${ACCOUNT}`, "other-worker", 60)).toBe(true);
      let calls = 0;
      let polls = 0;
      const p = createTokenProvider({
        engine: e, accountId: ACCOUNT, store: mem.store,
        refresh: async () => { calls++; return { accessToken: "never" }; },
        sleep: async () => {
          // The other worker finishes its refresh while this one waits.
          if (++polls === 2) {
            await mem.store.write(ACCOUNT, { accessToken: tok("a2"), refreshToken: tok("r2"), expiresAt: null });
            await releaseWorkerLock(e, `connector-refresh:${ACCOUNT}`, "other-worker");
          }
        },
      });
      expect(await p.refresh(tok("a1"))).toBe(tok("a2"));
      expect(calls).toBe(0);
    } finally { await db.close(); }
  });
});

describe("tokenEndpointRefresh", () => {
  const ORIGIN = ["https://oauth2", "provider", "test"].join(".");
  const SECRET = ["client", "secret", "value"].join("-");
  const json = (status: number, body: unknown): Recorded => ({ status, headers: { "content-type": "application/json" }, body });
  const refresher = (responses: Array<Recorded | Error>) => {
    const fake = replay(responses);
    const fn = tokenEndpointRefresh({ origin: ORIGIN, path: "/token", clientId: "client-1", clientSecret: SECRET, fetch: fake.fetch });
    return { fn, fake };
  };

  it("posts a refresh grant as a form to the fixed origin, never following a redirect", async () => {
    const { fn, fake } = refresher([json(200, { access_token: tok("a2"), expires_in: 3599, refresh_token: tok("r2") })]);
    expect(await fn(tok("r1"))).toEqual({ accessToken: tok("a2"), refreshToken: tok("r2"), expiresInSec: 3599 });
    expect(fake.urls).toEqual([`${ORIGIN}/token`]);
    const init = fake.inits[0]!;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: tok("r1"), client_id: "client-1", client_secret: SECRET });
  });

  it("refuses a token path that would resolve off the configured origin", () => {
    for (const path of ["/\\evil.example/token", "//evil.example/token", "token", "/a\\b"]) {
      expect(() => tokenEndpointRefresh({ origin: ORIGIN, path, clientId: "c", clientSecret: SECRET })).toThrow();
    }
  });

  it("reads invalid_grant as a reconnect", async () => {
    const { fn } = refresher([json(400, { error: "invalid_grant", error_description: `Token ${tok("r1")} has been expired or revoked.` })]);
    const err = await fn(tok("r1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect(String((err as Error).message)).not.toContain(tok("r1"));
  });

  it("reads a server error, a redirect, a network failure and a body without a token as transient, quoting no secret", async () => {
    for (const r of [json(503, { error: "x" }), { status: 302, headers: { location: "https://evil.example/" }, body: "" }, new Error(`reset ${SECRET}`), json(200, { token_type: "Bearer" })] as Array<Recorded | Error>) {
      const { fn } = refresher([r]);
      const err = await fn(tok("r1")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ReauthRequiredError);
      expect(String((err as Error).message)).not.toContain(SECRET);
      expect(String((err as Error).message)).not.toContain(tok("r1"));
    }
  });
});
