/**
 * The shipped Microsoft provider through the real connect flow (startConnect,
 * completeConnect, disconnectAccount) and the runtime's renewing token source,
 * against recorded identity-platform and Graph responses:
 *
 * - v2.0 endpoints with the tenant segment from the bring-your-own client
 *   (default `common`), PKCE S256, `prompt=select_account`, read-only
 *   delegated scopes per service;
 * - the exact-scope check tolerating Graph's URL spelling, the OpenID Connect
 *   scopes Microsoft leaves out or adds, and the read-only scopes the user
 *   already consented to for another service (consent outlives a disconnect);
 * - identity from Graph `/me`, labelled by the user principal name;
 * - admin-consent refusals as their own connect error;
 * - refresh-token rotation, and expired or interactive refreshes as a reconnect;
 * - a disconnect that calls no Microsoft endpoint and drops the credential.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import {
  MS_ACCESS_TOKEN,
  MS_REFRESH_TOKEN,
  MS_ROTATED_ACCESS_TOKEN,
  MS_ROTATED_REFRESH_TOKEN,
  microsoftFetch,
  tokenTenant,
  type MicrosoftWorld,
} from "./helpers/microsoft-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { credentialMeta, getAccount, readCredential } from "../src/core/connectors/accounts.ts";
import { getOAuthClient, setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { builtinProviders } from "../src/core/connectors/providers.ts";
import { completeConnect, ConnectError, connectorCallbackUri, disconnectAccount, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { oauthTokenSource } from "../src/core/connectors/runtime.ts";
import { ReauthRequiredError } from "../src/core/connectors/types.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const kek = kekFromBytes(randomBytes(32));
const SESSION = "admin-session-id-microsoft-aaaaaaaaaaaaaa";
const ENV = { MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-0000-0000-00000000c1d1", MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-ms-client-secret-value" };
const REDIRECT = connectorCallbackUri("https://brain.example.test", "microsoft");
const TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";

function deps(e: Engine, world: MicrosoftWorld, extra: Partial<ConnectDeps> = {}): ConnectDeps {
  return { engine: e, kek, providers: builtinProviders(), fetch: microsoftFetch(world), env: ENV, ...extra };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof ConnectError ? e.code : `other: ${String(e)}`;
  }
}

async function begin(d: ConnectDeps, sourceId: string, services: string[]) {
  const started = await startConnect(d, {
    provider: "microsoft", sourceId, services, principalRef: "admin:operator", adminSessionId: SESSION, redirectUri: REDIRECT,
  });
  const url = new URL(started.authorizeUrl);
  return { url, state: url.searchParams.get("state")! };
}

async function connect(d: ConnectDeps, sourceId: string, services: string[]) {
  const { state } = await begin(d, sourceId, services);
  return completeConnect(d, { provider: "microsoft", state, code: "M.C5-auth-code", adminSessionId: SESSION });
}

async function sources(e: Engine): Promise<void> {
  await registerSource(e, { id: "work-mail", kind: "mailbox", pathPrefix: "mail/" });
  await registerSource(e, { id: "work-calendar", kind: "calendar", pathPrefix: "calendar/" });
}

const rowCount = async (e: Engine, table: string) =>
  Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`microsoft provider (${name})`, () => {
  it("starts on the common v2.0 endpoint with PKCE, select_account and only read scopes", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const world: MicrosoftWorld = { calls: [] };
      const mail = (await begin(deps(e, world), "work-mail", ["outlook_mail"])).url;
      expect(`${mail.origin}${mail.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
      expect(mail.searchParams.get("scope")).toBe("openid email offline_access User.Read Mail.Read");
      expect(mail.searchParams.get("prompt")).toBe("select_account");
      expect(mail.searchParams.get("response_type")).toBe("code");
      expect(mail.searchParams.get("code_challenge_method")).toBe("S256");
      expect(mail.searchParams.get("client_id")).toBe(ENV.MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID);
      expect(mail.searchParams.get("redirect_uri")).toBe("https://brain.example.test/admin/connectors/callback/microsoft");
      expect(mail.searchParams.has("access_type")).toBe(false);

      const cal = (await begin(deps(e, world), "work-calendar", ["outlook_calendar"])).url;
      expect(cal.searchParams.get("scope")).toBe("openid email offline_access User.Read Calendars.Read");
      // A mail service cannot go into a calendar source.
      expect(await code(begin(deps(e, world), "work-calendar", ["outlook_mail"]))).toBe("source_kind");
      expect(world.calls).toEqual([]);
    } finally { await db.close(); }
  });

  it("uses the tenant saved with the bring-your-own client on every endpoint", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      await setOAuthClient(e, kek, "microsoft", "11111111-2222-3333-4444-a55555555555", "byo-ms-secret-value", TENANT_ID);
      expect(await getOAuthClient(e, kek, "microsoft")).toEqual({
        clientId: "11111111-2222-3333-4444-a55555555555", clientSecret: "byo-ms-secret-value", tenant: TENANT_ID,
      });
      const world: MicrosoftWorld = { calls: [] };
      const d = deps(e, world);
      const { url, state } = await begin(d, "work-mail", ["outlook_mail"]);
      expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
      await completeConnect(d, { provider: "microsoft", state, code: "M.C5-auth-code", adminSessionId: SESSION });
      const exchange = world.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!;
      expect(tokenTenant(exchange)).toBe(TENANT_ID);
      expect(exchange.body!.get("client_id")).toBe("11111111-2222-3333-4444-a55555555555");
      expect(exchange.body!.get("client_secret")).toBe("byo-ms-secret-value");
      expect(exchange.body!.get("code_verifier")).toMatch(/^[\w-]{43}$/);

      // The environment's tenant applies to the environment's client.
      await e.query(`DELETE FROM connector_oauth_clients`);
      const orgs = (await begin(deps(e, world, { env: { ...ENV, MEMRAIN_MICROSOFT_OAUTH_TENANT: "organizations" } }), "work-mail", ["outlook_mail"])).url;
      expect(orgs.pathname).toBe("/organizations/oauth2/v2.0/authorize");
      expect(await code(begin(deps(e, world, { env: { ...ENV, MEMRAIN_MICROSOFT_OAUTH_TENANT: "evil.example/../x" } }), "work-mail", ["outlook_mail"]))).toBe("invalid_tenant");
    } finally { await db.close(); }
  });

  it("refuses a tenant that is not a tenant id, domain or the three keywords", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const bad of ["", "a/b", "common?x=1", "../common", "evil.example#", "x".repeat(300)]) {
        await expect(setOAuthClient(e, kek, "microsoft", "client-id-1", "secret-value", bad)).rejects.toThrow("invalid tenant");
      }
      for (const good of ["common", "organizations", "consumers", TENANT_ID, "contoso.onmicrosoft.com"]) {
        await setOAuthClient(e, kek, "microsoft", "client-id-1", "secret-value", good);
        expect((await getOAuthClient(e, kek, "microsoft"))?.tenant).toBe(good);
      }
      // A client saved without a tenant reads back without one.
      await setOAuthClient(e, kek, "microsoft", "client-id-1", "secret-value");
      expect(await getOAuthClient(e, kek, "microsoft")).toEqual({ clientId: "client-id-1", clientSecret: "secret-value", tenant: null });
    } finally { await db.close(); }
  });

  it("accepts Graph's URL spelling and the OpenID scopes Microsoft drops or adds, labelled by the UPN", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const world: MicrosoftWorld = { calls: [] };
      const done = await connect(deps(e, world), "work-mail", ["outlook_mail"]);
      expect(done.account).toMatchObject({ provider: "microsoft", source_id: "work-mail", services: ["outlook_mail"], account_label: "owner@example.test", enabled: false, status: "active" });
      const me = world.calls.find((c) => c.url.pathname === "/v1.0/me")!;
      expect(me.url.searchParams.get("$select")).toBe("id,mail,userPrincipalName");
      expect(me.authorization).toBe(`Bearer ${MS_ACCESS_TOKEN}`);
      const cred = await readCredential(e, kek, done.account.id);
      expect(cred?.tokens).toMatchObject({ access_token: MS_ACCESS_TOKEN, refresh_token: MS_REFRESH_TOKEN });
      expect((await credentialMeta(e, done.account.id))?.scopes).toEqual(["Mail.Read", "User.Read", "email", "openid", "profile"]);

      // Lowercase, short names and no `scope` at all are the same grant.
      for (const grantedScope of ["mail.read user.read", null, "https://graph.microsoft.com/mail.read https://graph.microsoft.com/user.read offline_access"]) {
        expect(await code(connect(deps(e, { calls: [], grantedScope }), "work-mail", ["outlook_mail"]))).toBe("resolved");
      }
    } finally { await db.close(); }
  });

  it("refuses a grant with a write scope or without the requested read, and stores nothing", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      for (const grantedScope of [
        "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read openid",
        "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
        "https://graph.microsoft.com/User.Read openid email",
        "https://graph.microsoft.com/Mail.Read openid email",
      ]) {
        const world: MicrosoftWorld = { calls: [], grantedScope };
        const err = await connect(deps(e, world), "work-mail", ["outlook_mail"]).then(() => null, (x: unknown) => x);
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code).toBe("scope_mismatch");
        // Microsoft has no revocation endpoint for a delegated grant; nothing is called.
        expect((err as ConnectError).detail?.revoked).toBe(false);
        expect(world.calls.filter((c) => c.url.pathname === "/v1.0/me")).toEqual([]);
      }
      expect(await rowCount(e, "connector_accounts")).toBe(0);
      expect(await rowCount(e, "connector_credentials")).toBe(0);
    } finally { await db.close(); }
  });

  it("connects mail and calendar of one Microsoft account, before and after a disconnect", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const mail = await connect(deps(e, { calls: [] }), "work-mail", ["outlook_mail"]);
      // The calendar connect asks only for the calendar; a different user is never asked for mail.
      const world: MicrosoftWorld = { calls: [] };
      expect((await begin(deps(e, world), "work-calendar", ["outlook_calendar"])).url.searchParams.get("scope"))
        .toBe("openid email offline_access User.Read Calendars.Read");
      // Microsoft answers with everything this user consented to for Graph.
      const both = "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read openid profile email";
      const cal = await connect(deps(e, { calls: [], grantedScope: both }), "work-calendar", ["outlook_calendar"]);
      expect(cal.account).toMatchObject({ services: ["outlook_calendar"], account_label: "owner@example.test" });
      expect(cal.account.id).not.toBe(mail.account.id);

      // Disconnecting mail cannot withdraw the consent at Microsoft, so the
      // next calendar reconnect still carries Mail.Read; it is accepted.
      await disconnectAccount(deps(e, { calls: [] }), mail.account.id);
      const again = await connect(deps(e, { calls: [], grantedScope: both }), "work-calendar", ["outlook_calendar"]);
      expect(again.reconnected).toBe(true);
      // A scope of no service of this provider is still refused.
      expect(await code(connect(deps(e, { calls: [], grantedScope: `${both} https://graph.microsoft.com/Files.Read` }), "work-calendar", ["outlook_calendar"]))).toBe("scope_mismatch");
      // Nor does a prior consent let a write scope through.
      for (const write of ["Mail.ReadWrite", "Calendars.ReadWrite", "Mail.Send"]) {
        expect(await code(connect(deps(e, { calls: [], grantedScope: `${both} https://graph.microsoft.com/${write}` }), "work-calendar", ["outlook_calendar"]))).toBe("scope_mismatch");
      }
    } finally { await db.close(); }
  });

  it("refuses a grant without the refresh token offline_access asked for", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const world: MicrosoftWorld = { calls: [], omitRefreshToken: true };
      expect(await code(connect(deps(e, world), "work-mail", ["outlook_mail"]))).toBe("token_exchange");
      // Without a refresh token the account would stop an hour later; nothing is stored.
      expect(await rowCount(e, "connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  it("names an admin-consent refusal at the code exchange, and keeps other refusals generic", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      for (const codeError of ["adminConsentRequired", "adminConsentWorkflow"]) {
        expect(await code(connect(deps(e, { calls: [], codeError }), "work-mail", ["outlook_mail"]))).toBe("admin_consent_required");
      }
      expect(await code(connect(deps(e, { calls: [], codeError: "codeRedeemed" }), "work-mail", ["outlook_mail"]))).toBe("token_exchange");
      expect(await rowCount(e, "connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  it("labels a personal account by its sign-in address, a guest by its mail, and refuses no address", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const personal = await connect(deps(e, { calls: [], me: "meConsumer" }), "work-mail", ["outlook_mail"]);
      expect(personal.account.account_label).toBe("someone@outlook.example.test");
      const guest = await connect(deps(e, { calls: [], me: "meGuest" }), "work-mail", ["outlook_mail"]);
      expect(guest.account.account_label).toBe("guest@partner.example.test");
      expect(await code(connect(deps(e, { calls: [], me: "meNoAddress" }), "work-mail", ["outlook_mail"]))).toBe("identity");
    } finally { await db.close(); }
  });

  it("disconnects without calling Microsoft and drops the credential", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const done = await connect(deps(e, { calls: [] }), "work-mail", ["outlook_mail"]);
      const world: MicrosoftWorld = { calls: [] };
      expect(await disconnectAccount(deps(e, world), done.account.id)).toEqual({ revoked: false, credentialKept: false });
      expect(world.calls).toEqual([]);
      expect(await readCredential(e, kek, done.account.id)).toBeNull();
      expect(await getAccount(e, done.account.id)).toMatchObject({ status: "revoked", enabled: false });
      expect(builtinProviders().get("microsoft")!.consentUrls).toEqual(["https://myapplications.microsoft.com", "https://account.microsoft.com/privacy/app-access"]);
    } finally { await db.close(); }
  });

  it("renews through the tenant's token endpoint and stores the rotated refresh token", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      await setOAuthClient(e, kek, "microsoft", "client-id-1", "secret-value", "organizations");
      const done = await connect(deps(e, { calls: [] }), "work-mail", ["outlook_mail"]);
      const world: MicrosoftWorld = { calls: [] };
      const source = await oauthTokenSource({
        engine: e, kek, providers: builtinProviders(), provider: "microsoft", accountId: done.account.id, fetch: microsoftFetch(world), env: ENV, secret: () => {},
      });
      expect(await source.refresh(MS_ACCESS_TOKEN)).toBe(MS_ROTATED_ACCESS_TOKEN);
      const call = world.calls.find((c) => c.body?.get("grant_type") === "refresh_token")!;
      expect(tokenTenant(call)).toBe("organizations");
      expect(call.body!.get("refresh_token")).toBe(MS_REFRESH_TOKEN);
      expect((await readCredential(e, kek, done.account.id))?.tokens).toMatchObject({
        access_token: MS_ROTATED_ACCESS_TOKEN, refresh_token: MS_ROTATED_REFRESH_TOKEN,
      });
    } finally { await db.close(); }
  });

  it("turns an expired or interactive refresh into a reconnect that names the code", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await sources(e);
      const done = await connect(deps(e, { calls: [] }), "work-mail", ["outlook_mail"]);
      for (const [refreshError, expected] of [["refreshExpiredInactive", /invalid_grant.*700082/], ["refreshInteractionRequired", /interaction_required.*50076/], ["adminConsentRequired", /invalid_grant.*65001/]] as const) {
        const source = await oauthTokenSource({
          engine: e, kek, providers: builtinProviders(), provider: "microsoft", accountId: done.account.id,
          fetch: microsoftFetch({ calls: [], refreshError }), env: ENV, secret: () => {},
        });
        const err = await source.refresh(MS_ACCESS_TOKEN).then(() => null, (x: unknown) => x);
        expect(err).toBeInstanceOf(ReauthRequiredError);
        expect((err as Error).message).toMatch(expected);
        expect((err as Error).message).not.toContain("AADSTS");
      }
    } finally { await db.close(); }
  });
});
