/**
 * The Connections page's calendar picker: GET lists the calendars a Google
 * account can read (primary first, busy-only ones left out) with which of them
 * sync, and POST saves the owner's choice and history window into the
 * account's config. Only calendars Google lists for the account are accepted,
 * primary is always synced and never stored, no token reaches a response, and
 * nothing runs while connectors are off. Both engines, against the recorded
 * Google account; no request leaves the process.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GOOGLE_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, googleFetch, type GoogleWorld } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/vault.ts";
import { createAccount, getAccount, storeCredential, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { googleProvider, GOOGLE_CALENDAR_READONLY } from "../src/core/connectors/google/provider.ts";
import { handleAdminConnectors, type AdminConnectorDeps } from "../src/http/admin-connectors.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";

const kek = kekFromBytes(randomBytes(32));
const ORIGIN = "https://brain.example.test";
const OWNER = "owner@example.test";
const TEAM = "team0abc123@group.calendar.google.com";
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};

function deps(storage: Storage, world: GoogleWorld, extra: Partial<AdminConnectorDeps> = {}): AdminConnectorDeps {
  const providers = new ProviderRegistry();
  providers.register(googleProvider());
  return {
    storage,
    publicUrl: ORIGIN,
    adminSessionId: () => "sess-1",
    status: () => ({ enabled: true, kekId: kek.id, reason: null }),
    kek: () => kek,
    providers,
    fetch: googleFetch(world),
    env: ENV,
    ...extra,
  };
}

const get = (path: string) => new Request(`${ORIGIN}${path}`);
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(req: Request, d: AdminConnectorDeps): Promise<Response> {
  const res = await handleAdminConnectors(req, new URL(req.url), d);
  if (!res) throw new Error(`route not handled: ${req.method} ${req.url}`);
  return res;
}

async function googleAccount(engine: Engine, config: Record<string, unknown> = {}): Promise<ConnectorAccount> {
  await registerSource(engine, { id: "cal", kind: "calendar", pathPrefix: "calendar/" });
  const account = await createAccount(engine, {
    sourceId: "cal", provider: "google", services: ["calendar"], principalRef: "admin:operator", accountLabel: OWNER, config,
  });
  await storeCredential(engine, kek, account, { access_token: GOOGLE_ACCESS_TOKEN, refresh_token: GOOGLE_REFRESH_TOKEN }, {
    scopes: [GOOGLE_CALENDAR_READONLY], expiresAt: null,
  });
  return account;
}

const world = (): GoogleWorld => ({ calls: [], events: () => "eventsDelta" });

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin calendar picker (${name})`, () => {
  it("lists the readable calendars, which of them sync, and the history window, with no token", async () => {
    const db = await open();
    try {
      const account = await googleAccount(db.storage.engine(), { calendars: [TEAM], history_days: 30 });
      const w = world();
      const res = await call(get(`/admin/api/connectors/accounts/${account.id}/calendars`), deps(db.storage, w));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(GOOGLE_ACCESS_TOKEN);
      expect(text).not.toContain(GOOGLE_REFRESH_TOKEN);
      expect(JSON.parse(text)).toEqual({
        calendars: [
          { id: OWNER, summary: OWNER, primary: true, access_role: "owner", selected: true },
          { id: TEAM, summary: "Team", primary: false, access_role: "reader", selected: true },
        ],
        history_days: 30,
      });
      expect(w.calls.some(c => c.url.pathname === "/calendar/v3/users/me/calendarList")).toBe(true);
    } finally { await db.close(); }
  });

  it("saves the chosen calendars and history window, keeping primary out of the stored list and other settings as they were", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await googleAccount(e, { keep: "me" });
      const res = await call(post(`/admin/api/connectors/accounts/${account.id}/calendars`, { calendars: [OWNER, TEAM], history_days: 365 }), deps(db.storage, world()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, calendars: [TEAM], history_days: 365 });
      expect((await getAccount(e, account.id))!.config).toEqual({ keep: "me", calendars: [TEAM], history_days: 365 });

      // Unselecting everything leaves primary alone.
      await call(post(`/admin/api/connectors/accounts/${account.id}/calendars`, { calendars: [] }), deps(db.storage, world()));
      expect((await getAccount(e, account.id))!.config).toEqual({ keep: "me", calendars: [], history_days: 365 });
    } finally { await db.close(); }
  });

  it("refuses a calendar Google does not list for the account and a history window out of range", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await googleAccount(e, { calendars: [TEAM] });
      const path = `/admin/api/connectors/accounts/${account.id}/calendars`;
      const busy = await call(post(path, { calendars: ["free0busy@group.calendar.google.com"] }), deps(db.storage, world()));
      expect(busy.status).toBe(400);
      expect(await busy.json()).toMatchObject({ error: "unknown_calendar" });
      for (const history_days of [0, 3651, 1.5, "90"]) {
        const bad = await call(post(path, { history_days }), deps(db.storage, world()));
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: "invalid_history_days" });
      }
      expect((await call(post(path, { calendars: "all" }), deps(db.storage, world()))).status).toBe(400);
      expect((await getAccount(e, account.id))!.config).toEqual({ calendars: [TEAM] });
    } finally { await db.close(); }
  });

  it("stays closed while connectors are off and for an account that is not Google Calendar", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const account = await googleAccount(e);
      const w = world();
      const off = deps(db.storage, w, { status: () => ({ enabled: false, kekId: null, reason: "MEMRAIN_CONNECTORS_ENABLED is not set" }), kek: () => null });
      expect((await call(get(`/admin/api/connectors/accounts/${account.id}/calendars`), off)).status).toBe(403);
      expect((await call(post(`/admin/api/connectors/accounts/${account.id}/calendars`, { calendars: [] }), off)).status).toBe(403);
      expect(w.calls).toEqual([]);

      await registerSource(e, { id: "meet", kind: "meeting", pathPrefix: "meeting/" });
      const other = await createAccount(e, { sourceId: "meet", provider: "fireflies", services: ["fireflies"], principalRef: "admin:operator", accountLabel: OWNER });
      const res = await call(get(`/admin/api/connectors/accounts/${other.id}/calendars`), deps(db.storage, w));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "no_calendars" });
    } finally { await db.close(); }
  });
});
