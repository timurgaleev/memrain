/**
 * Gmail on the Google provider: the service asks for gmail.readonly only and
 * writes into a mailbox source. Google folds every scope a user granted one
 * OAuth client into each new grant of that client, so a Gmail connect next to
 * a connected calendar asks for both scopes: the grant then equals the request
 * and the exact-scope check stays exact. A grant that drops one is refused.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GOOGLE_FIXTURES, googleFetch, type GoogleWorld } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/vault.ts";
import { credentialMeta, getAccount, listAccounts, readCredential } from "../src/core/connectors/accounts.ts";
import { completeConnect, ConnectError, connectorCallbackUri, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { builtinProviders, ProviderRegistry } from "../src/core/connectors/providers.ts";
import { GMAIL_API_ORIGIN, GMAIL_MIN_SPACING_MS, GOOGLE_CALENDAR_READONLY, GOOGLE_GMAIL_READONLY, googleProvider } from "../src/core/connectors/google/provider.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";

setDefaultTimeout(30_000);

const kek = kekFromBytes(randomBytes(32));
const SESSION = `admin-session-id-${"m".repeat(24)}`;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const EMAIL_URL = "https://www.googleapis.com/auth/userinfo.email";

describe("google provider: gmail service", () => {
  it("adds gmail with gmail.readonly only, into a mailbox source, read from the Gmail API origin", () => {
    const google = builtinProviders().get("google")!;
    expect(Object.keys(google.services)).toEqual(["calendar", "gmail"]);
    expect(google.services.gmail!.scopes).toEqual([GOOGLE_GMAIL_READONLY]);
    expect(GOOGLE_GMAIL_READONLY).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(google.services.gmail!.sourceKinds).toEqual(["mailbox"]);
    expect(google.services.gmail!.apiOrigin).toBe(GMAIL_API_ORIGIN);
    expect(GMAIL_API_ORIGIN).toBe("https://gmail.googleapis.com");
    expect(google.combinedGrants).toBe(true);
    const all = [...google.baseScopes, ...Object.values(google.services).flatMap(s => s.scopes)];
    for (const s of all) expect(["openid", "email"].includes(s) || s.endsWith(".readonly")).toBe(true);
  });

  it("refuses to register a service whose API origin is not https", () => {
    const bad = { ...googleProvider(), services: { gmail: { scopes: [GOOGLE_GMAIL_READONLY], sourceKinds: ["mailbox"] as const, apiOrigin: "http://gmail.googleapis.com" } } };
    expect(() => new ProviderRegistry().register(bad)).toThrow(/https/);
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail connect (${name})`, () => {
  function deps(e: ConnectDeps["engine"], world: GoogleWorld): ConnectDeps {
    const r = new ProviderRegistry();
    r.register(googleProvider());
    return { engine: e, kek, providers: r, fetch: googleFetch(world), env: ENV, now: () => Date.parse("2026-11-16T10:00:00Z") };
  }

  async function connect(d: ConnectDeps, sourceId: string, services: string[], grantedScope: string, world: GoogleWorld) {
    const started = await startConnect(d, {
      provider: "google", sourceId, services, principalRef: "admin:operator", adminSessionId: SESSION,
      redirectUri: connectorCallbackUri("https://brain.example.test", "google"),
    });
    const url = new URL(started.authorizeUrl);
    world.grantedScope = grantedScope;
    const done = await completeConnect(d, { provider: "google", state: url.searchParams.get("state"), code: "4/0test-auth-code", adminSessionId: SESSION });
    return { url, account: done.account };
  }

  it("asks a first Gmail connect for openid, email and gmail.readonly only", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const { url, account } = await connect(deps(e, world), "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world);
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_GMAIL_READONLY}`);
      expect(url.searchParams.get("include_granted_scopes")).toBeNull();
      expect(account.services).toEqual(["gmail"]);
      expect(account.enabled).toBe(false);
    } finally { await db.close(); }
  });

  it("refuses Gmail into a calendar source", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const err = await connect(deps(e, world), "cal", ["gmail"], "", world).catch(x => x);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("source_kind");
    } finally { await db.close(); }
  });

  it("asks for the union next to a connected calendar and keeps the exact-scope check", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const d = deps(e, world);
      await connect(d, "cal", ["calendar"], String(GOOGLE_FIXTURES.token!.scope), world);

      const union = `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`;
      const { url, account } = await connect(d, "mail", ["gmail"], union, world);
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`);
      // The account syncs what its source holds; the extra scope only keeps the grant exact.
      expect(account.services).toEqual(["gmail"]);
      expect(account.source_id).toBe("mail");
      expect((await credentialMeta(e, account.id))!.scopes).toEqual(["email", GOOGLE_CALENDAR_READONLY, GOOGLE_GMAIL_READONLY, "openid"]);

      // Another Google user, whose calendar is not connected here, unticks the
      // calendar box: the grant is exactly what the Gmail service needs.
      await registerSource(e, { id: "mail2", kind: "mailbox", pathPrefix: "mail2/" });
      const other = await connect(d, "mail2", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world);
      expect(other.account.services).toEqual(["gmail"]);
      expect((await credentialMeta(e, other.account.id))!.scopes).toEqual(["email", GOOGLE_GMAIL_READONLY, "openid"]);

      // Unticking Gmail itself leaves a grant that is neither set: refused. The
      // same Google user's calendar and mailbox are live on that grant, so it
      // is not revoked (revoking would end their access too).
      world.calls.length = 0;
      const err = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY}`, world).catch(x => x);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("scope_mismatch_not_revoked");
      expect((err as ConnectError).detail).toMatchObject({ missing: [GOOGLE_GMAIL_READONLY], extra: [] });
      expect(world.calls.some(c => c.url.toString() === "https://oauth2.googleapis.com/revoke")).toBe(false);

      // A scope nobody asked for is refused whichever set it is measured against.
      const wider = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify`, world).catch(x => x);
      expect((wider as ConnectError).code).toBe("scope_mismatch_not_revoked");
    } finally { await db.close(); }
  });

  it("asks a calendar reconnect for Gmail's scope too once a mailbox is connected", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const d = deps(e, world);
      await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world);
      const { url, account } = await connect(d, "cal", ["calendar"], `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`, world);
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`);
      expect(account.services).toEqual(["calendar"]);
    } finally { await db.close(); }
  });

  it("wires a Gmail account's client to the Gmail origin with Gmail's pacing, and a calendar account's to the Calendar origin", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const d = deps(e, world);
      const mail = (await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world)).account;
      const cal = (await connect(d, "cal", ["calendar"], `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`, world)).account;
      const sleeps: number[] = [];
      const seen: string[] = [];
      const rt = connectorRuntime(db.storage, {
        kek, providers: d.providers, env: ENV, now: () => 0, sleep: async (ms) => { sleeps.push(ms); },
        fetch: async (url) => { seen.push(new URL(url).origin); return Response.json({}); },
      });
      for (const a of [mail, cal]) {
        const sync = (await rt.loadAccount(a.id))!;
        const wiring = rt.depsFor(sync);
        const client = wiring.client(sync, await wiring.tokenSource(sync, () => {}));
        await client.get("/x");
        await client.get("/y");
      }
      expect(seen).toEqual([GMAIL_API_ORIGIN, GMAIL_API_ORIGIN, "https://www.googleapis.com", "https://www.googleapis.com"]);
      // The Gmail pair is spaced by Gmail's own gap.
      expect(sleeps).toContain(GMAIL_MIN_SPACING_MS);
    } finally { await db.close(); }
  });

  describe("a refused grant next to a live account of the same Google user", () => {
    const revokes = (world: GoogleWorld) => world.calls.filter(c => c.url.toString() === "https://oauth2.googleapis.com/revoke").length;
    const onlyCalendar = `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY}`;

    async function withCalendar(e: ConnectDeps["engine"], world: GoogleWorld) {
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const d = deps(e, world);
      const cal = (await connect(d, "cal", ["calendar"], String(GOOGLE_FIXTURES.token!.scope), world)).account;
      const before = await readCredential(e, kek, cal.id);
      world.calls.length = 0;
      return { d, cal, before };
    }

    it("leaves the shared grant in place when Gmail comes back without its scope, and stores nothing", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const { d, cal, before } = await withCalendar(e, world);
        const err = await connect(d, "mail", ["gmail"], onlyCalendar, world).catch(x => x);
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code).toBe("scope_mismatch_not_revoked");
        expect((err as ConnectError).detail).toMatchObject({ missing: [GOOGLE_GMAIL_READONLY], extra: [], revoked: false });
        // Revoking any token of the grant would end the calendar's access too.
        expect(revokes(world)).toBe(0);
        expect(await readCredential(e, kek, cal.id)).toEqual(before);
        expect((await getAccount(e, cal.id))!.status).toBe("active");
        expect((await listAccounts(e)).map(a => a.id)).toEqual([cal.id]);
      } finally { await db.close(); }
    });

    it("leaves the shared grant in place when the identity cannot be read", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const { d, cal, before } = await withCalendar(e, world);
        world.userinfo = { email: "owner@example.test", email_verified: false };
        const err = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`, world).catch(x => x);
        expect((err as ConnectError).code).toBe("identity_not_revoked");
        expect(revokes(world)).toBe(0);
        expect(await readCredential(e, kek, cal.id)).toEqual(before);
        expect((await listAccounts(e)).map(a => a.id)).toEqual([cal.id]);
      } finally { await db.close(); }
    });

    it("still revokes a refused grant no live account shares", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const d = deps(e, world);
        const err = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL}`, world).catch(x => x);
        expect((err as ConnectError).code).toBe("scope_mismatch");
        expect((err as ConnectError).detail).toMatchObject({ revoked: true });
        expect(revokes(world)).toBe(1);

        world.calls.length = 0;
        world.userinfo = { email: "owner@example.test", email_verified: false };
        const unread = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world).catch(x => x);
        expect((unread as ConnectError).code).toBe("identity");
        expect(revokes(world)).toBe(1);
        expect(await listAccounts(e)).toEqual([]);
      } finally { await db.close(); }
    });

    it("leaves the grant in place under another email too, since a renamed Google user keeps the grant", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const { d, cal, before } = await withCalendar(e, world);
        // The label is the email; a Workspace rename changes it for the same grant.
        world.userinfo = { email: "renamed-owner@example.test", email_verified: true };
        const other = await connect(d, "mail", ["gmail"], onlyCalendar, world).catch(x => x);
        expect((other as ConnectError).code).toBe("scope_mismatch_not_revoked");
        expect(revokes(world)).toBe(0);
        expect(await readCredential(e, kek, cal.id)).toEqual(before);
      } finally { await db.close(); }
    });

    it("still revokes once the only other account was disconnected", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const { d, cal } = await withCalendar(e, world);
        await e.query(`UPDATE connector_accounts SET status = 'revoked' WHERE id = $1`, [cal.id]);
        const parked = await connect(d, "mail", ["gmail"], onlyCalendar, world).catch(x => x);
        expect((parked as ConnectError).code).toBe("scope_mismatch");
        expect(revokes(world)).toBe(1);
      } finally { await db.close(); }
    });

    it("does not revoke a token it failed to store when a live account shares its grant", async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
        const { d, before, cal } = await withCalendar(e, world);
        const failing = new Proxy(e, {
          get: (t, k) => (k === "transaction" ? async () => { throw new Error("store failed"); } : (v => (typeof v === "function" ? v.bind(t) : v))(Reflect.get(t, k))),
        });
        const union = `openid ${EMAIL_URL} ${GOOGLE_CALENDAR_READONLY} ${GOOGLE_GMAIL_READONLY}`;
        const shared = await connect({ ...d, engine: failing }, "mail", ["gmail"], union, world).catch(x => x);
        expect((shared as Error).message).toBe("store failed");
        expect(revokes(world)).toBe(0);
        expect(await readCredential(e, kek, cal.id)).toEqual(before);

        await e.query(`UPDATE connector_accounts SET status = 'revoked' WHERE id = $1`, [cal.id]);
        const alone = await connect({ ...d, engine: failing }, "mail", ["gmail"], union, world).catch(x => x);
        expect((alone as Error).message).toBe("store failed");
        expect(revokes(world)).toBe(1);
      } finally { await db.close(); }
    });
  });

  it("drops a disconnected account's scopes from the union", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const world: GoogleWorld = { calls: [], events: () => "eventsDelta" };
      const d = deps(e, world);
      const cal = await connect(d, "cal", ["calendar"], String(GOOGLE_FIXTURES.token!.scope), world);
      // A disconnect deletes the credential (and Google's revoke ends the combined grant).
      await e.query(`DELETE FROM connector_credentials WHERE account_id = $1`, [cal.account.id]);
      const { url } = await connect(d, "mail", ["gmail"], `openid ${EMAIL_URL} ${GOOGLE_GMAIL_READONLY}`, world);
      expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_GMAIL_READONLY}`);
    } finally { await db.close(); }
  });
});
