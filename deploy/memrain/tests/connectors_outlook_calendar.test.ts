/**
 * The Microsoft provider and its Outlook calendar adapter against recorded
 * Graph responses (tests/fixtures/connectors/outlook-calendar.json), on both
 * engines: connect over PKCE with a read-only grant (Graph answers the scope
 * list in its own spelling and leaves the OpenID scopes out), a windowed
 * first calendar-view delta whose delta link is committed only after the last
 * page, a delta round that updates, cancels and removes events, a lost sync
 * state that re-lists the window and deletes what is gone, a weekly relist
 * that moves the window forward, a vanished secondary calendar, a throttled
 * request waited out, and a refused refresh that parks the account. The
 * pure parts (time parsing, response mapping, recurrence, the join-URL
 * scrub) and render parity with Google Calendar are checked without a
 * database.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deltaCalls, GRAPH_ACCESS_TOKEN, GRAPH_FIXTURES, graphFetch, MS_TOKEN_URL, type GraphWorld } from "./helpers/graph-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { getAccount, setAccountConfig, setAccountEnabled, type ConnectorAccount } from "../src/core/connectors/accounts.ts";
import { completeConnect, ConnectError, connectorCallbackUri, disconnectAccount, startConnect, type ConnectDeps } from "../src/core/connectors/oauth-connect.ts";
import { builtinProviders, normalizeTenant, oauthEndpoints, ProviderRegistry } from "../src/core/connectors/providers.ts";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { readCursor } from "../src/core/connectors/sync-store.ts";
import { runConnectorSync, type SyncAccount } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { accountRef, shortHash, type ConnectorContext } from "../src/core/connectors/model.ts";
import { renderCalendarEvent } from "../src/core/connectors/render.ts";
import { normalizeGoogleEvent } from "../src/core/connectors/google/calendar.ts";
import { MICROSOFT_CALENDARS_READ, microsoftProvider } from "../src/core/connectors/microsoft/provider.ts";
import {
  graphTime,
  listOutlookCalendars,
  normalizeOutlookEvent,
  OUTLOOK_PREFER,
  outlookCalendarAdapter,
  outlookCalendarStream,
  parseOutlookCursor,
  recurrenceToRrule,
} from "../src/core/connectors/microsoft/calendar.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(30_000);

const kek = kekFromBytes(randomBytes(32));
const SESSION = `admin-session-id-${"m".repeat(24)}`;
const SOURCE = "cal";
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const T1 = T0 + DAY;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-4000-8000-00000000c11e",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-ms-client-secret-value",
};
const SKIP_PATH = "/v1.0/me/calendarView/delta?$skiptoken=skip-page-2";
const DELTA_ONE = "/v1.0/me/calendarView/delta?$deltatoken=delta-one";
const TEAM = "AAMkCalTeam0001=";

const eventKey = (eventId: string, calendar = "primary") => `${shortHash(`ocal:${calendar}`)}:${eventId}`;
const pageSlug = (iCalUId: string) => `calendar/${accountRef(OWNER)}/${shortHash(`ical:${iCalUId}`)}`;
const E1 = pageSlug("040000008200E00074C5B7101A82E0080000000001E1");
const E2 = pageSlug("040000008200E00074C5B7101A82E0080000000003E2");
const E3 = pageSlug("040000008200E00074C5B7101A82E0080000000004E3");
const S1 = pageSlug("040000008200E00074C5B7101A82E0080000000005S1");

/** The first sync: two delta pages, then the series' master and instances. */
function firstSyncWorld(): GraphWorld {
  return {
    calls: [],
    delta: (_cal, q) => (q.get("$skiptoken") === "skip-page-2" ? "deltaFirstPage2" : q.get("$deltatoken") === "delta-one" ? "deltaChanges" : "deltaFirstPage1"),
    event: (_cal, id) => (id === "AAMkS1master=" ? "seriesS1Master" : { status: 404, body: GRAPH_FIXTURES.errorItemNotFound! }),
    instances: () => "instancesS1",
  };
}

function syncAccount(config: Record<string, unknown> = {}, services: string[] = ["outlook_calendar"]): SyncAccount {
  return {
    id: "00000000-0000-4000-8000-00000000000b", sourceId: SOURCE, provider: "microsoft", enabled: true, status: "active",
    itemCapDaily: 5000, spendCapUsdDaily: 1, accountLabel: OWNER, services, config,
  };
}

const ctx = (service: ConnectorContext["service"]): ConnectorContext => ({ service, accountLabel: OWNER });

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

describe("microsoft provider", () => {
  it("ships in the built-in registry with read-only calendar access on the v2.0 endpoints of the common tenant", () => {
    const ms = builtinProviders().get("microsoft");
    expect(ms).not.toBeNull();
    expect(oauthEndpoints(ms!).authorizeUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(oauthEndpoints(ms!).tokenUrl).toBe(MS_TOKEN_URL);
    // The identity platform has no RFC 7009 endpoint for a delegated refresh token.
    expect(ms!.revokeUrl).toBeUndefined();
    expect(ms!.baseScopes).toEqual(["openid", "email", "offline_access", "User.Read"]);
    expect(ms!.services.outlook_calendar!.scopes).toEqual([MICROSOFT_CALENDARS_READ]);
    expect(ms!.services.outlook_calendar!.sourceKinds).toEqual(["calendar"]);
    expect(ms!.services.outlook_calendar!.headers).toEqual({ Prefer: OUTLOOK_PREFER });
    expect(OUTLOOK_PREFER).toContain("outlook.timezone=\"UTC\"");
    expect(OUTLOOK_PREFER).toContain("odata.maxpagesize=");
    expect(ms!.sync?.apiOrigin).toBe("https://graph.microsoft.com");
    // Nothing it can ask for writes.
    const all = [...ms!.baseScopes, ...Object.values(ms!.services).flatMap(s => s.scopes)];
    for (const s of all) expect(/write/i.test(s)).toBe(false);
  });

  it("takes a tenant segment that names a tenant and refuses one that does not", () => {
    for (const ok of ["common", "organizations", "consumers", "0f0e0d0c-0b0a-4908-8706-050403020100", "contoso.onmicrosoft.com"]) expect(normalizeTenant(ok)).toBe(ok);
    for (const bad of ["evil.example/../x", "common?x=1", "", "a b", "x/y"]) expect(normalizeTenant(bad)).toBeNull();
    const ms = microsoftProvider();
    expect(oauthEndpoints(ms, "organizations").authorizeUrl).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    // A tenant that is not one never reaches a URL.
    expect(() => oauthEndpoints(ms, "x/y")).toThrow();
    expect(builtinProviders().get("google")).not.toBeNull();
  });

  it("maps Graph's spelling of a granted scope back to the requested one", () => {
    const ms = microsoftProvider();
    expect(ms.normalizeScope!("https://graph.microsoft.com/Calendars.Read")).toBe("Calendars.Read");
    expect(ms.normalizeScope!("calendars.read")).toBe("Calendars.Read");
    expect(ms.normalizeScope!("User.Read")).toBe("User.Read");
    expect(ms.normalizeScope!("https://graph.microsoft.com/Calendars.ReadWrite")).toBe("Calendars.ReadWrite");
  });

  it("identifies the account by its sign-in name, a guest by its Graph mail address, lowercased", async () => {
    const ms = microsoftProvider();
    const w: GraphWorld = { calls: [], delta: () => "deltaEmpty" };
    expect(await ms.identify({ fetch: graphFetch(w), accessToken: GRAPH_ACCESS_TOKEN, tokenResponse: {} })).toBe(OWNER);
    expect(w.calls[0]!.url.toString()).toBe("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName");
    const personal: GraphWorld = { calls: [], delta: () => "deltaEmpty", me: { id: "x", mail: null, userPrincipalName: "Someone@Outlook.example" } };
    expect(await ms.identify({ fetch: graphFetch(personal), accessToken: GRAPH_ACCESS_TOKEN, tokenResponse: {} })).toBe("someone@outlook.example");
    const nameless: GraphWorld = { calls: [], delta: () => "deltaEmpty", me: { id: "x", mail: null, userPrincipalName: "not-an-address" } };
    await expect(ms.identify({ fetch: graphFetch(nameless), accessToken: GRAPH_ACCESS_TOKEN, tokenResponse: {} })).rejects.toThrow();
  });
});

describe("outlook calendar, pure parts", () => {
  it("reads Graph's seven-digit UTC times and all-day dates, and refuses a zone it did not ask for", () => {
    expect(graphTime({ dateTime: "2026-11-18T09:00:00.0000000", timeZone: "UTC" }, false)).toBe("2026-11-18T09:00:00.000Z");
    expect(graphTime({ dateTime: "2026-11-18T09:00:00.1234567", timeZone: "UTC" }, false)).toBe("2026-11-18T09:00:00.123Z");
    expect(graphTime({ dateTime: "2026-11-18T09:00:00", timeZone: "Etc/UTC" }, false)).toBe("2026-11-18T09:00:00.000Z");
    expect(graphTime({ dateTime: "2026-11-20T00:00:00.0000000", timeZone: "UTC" }, true)).toBe("2026-11-20");
    expect(graphTime({ dateTime: "2026-11-18T09:00:00.0000000", timeZone: "Pacific Standard Time" }, false)).toBeNull();
    expect(graphTime({ dateTime: "yesterday", timeZone: "UTC" }, false)).toBeNull();
    expect(graphTime(null, false)).toBeNull();
  });

  it("turns each recurrence pattern into the RRULE Google would show", () => {
    const rule = (pattern: Record<string, unknown>, range: Record<string, unknown> = { type: "noEnd", startDate: "2026-01-05" }) =>
      recurrenceToRrule({ pattern, range });
    expect(rule({ type: "daily", interval: 1 })).toEqual(["RRULE:FREQ=DAILY"]);
    expect(rule({ type: "daily", interval: 3 })).toEqual(["RRULE:FREQ=DAILY;INTERVAL=3"]);
    expect(rule({ type: "weekly", interval: 1, daysOfWeek: ["monday", "wednesday"] })).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]);
    expect(rule({ type: "absoluteMonthly", interval: 1, dayOfMonth: 15 })).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"]);
    expect(rule({ type: "relativeMonthly", interval: 2, daysOfWeek: ["thursday"], index: "last" })).toEqual(["RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=TH;BYSETPOS=-1"]);
    expect(rule({ type: "absoluteYearly", interval: 1, month: 3, dayOfMonth: 9 })).toEqual(["RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=9"]);
    expect(rule({ type: "relativeYearly", interval: 1, month: 11, daysOfWeek: ["thursday"], index: "fourth" })).toEqual(["RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4"]);
    expect(rule({ type: "weekly", interval: 1, daysOfWeek: ["friday"] }, { type: "endDate", startDate: "2026-01-02", endDate: "2026-06-26" }))
      .toEqual(["RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20260626"]);
    expect(rule({ type: "daily", interval: 1 }, { type: "numbered", startDate: "2026-01-02", numberOfOccurrences: 10 })).toEqual(["RRULE:FREQ=DAILY;COUNT=10"]);
    for (const bad of [{ type: "hourly", interval: 1 }, { type: "weekly", interval: 1, daysOfWeek: ["someday"] }, { type: "daily", interval: 0 }]) {
      expect(rule(bad)).toBeNull();
    }
    expect(recurrenceToRrule(null)).toBeNull();
  });

  it("maps the owner's own answer from responseStatus and drops rooms", () => {
    const base = (GRAPH_FIXTURES.deltaFirstPage1!.value as Record<string, unknown>[])[0]!;
    const e1 = normalizeOutlookEvent("primary", base, OWNER)!;
    expect(e1.attendees).toEqual([
      { name: "Ana Lee", email: "ana@example.net", response: "accepted" },
      { name: "Owner Example", email: "owner@example.test", response: "needsAction" },
    ]);
    expect(e1.status).toBe("confirmed");
    expect(e1.start).toBe("2026-11-18T09:00:00.000Z");
    expect(e1.organizer).toEqual({ name: "Dan Park", email: "dan@example.org" });

    // An organizer who asked for no answer is owed none.
    const noAnswer = normalizeOutlookEvent("primary", { ...base, responseRequested: false }, OWNER)!;
    expect(noAnswer.attendees.find(a => a.email === OWNER)!.response).toBe("not requested");
    // Invited through a list: the owner is not among the attendees and is added with their own answer.
    const viaList = normalizeOutlookEvent("primary", { ...base, attendees: [(base.attendees as unknown[])[0]] }, OWNER)!;
    expect(viaList.attendees.at(-1)).toEqual({ name: null, email: OWNER, response: "needsAction" });
    const mine = normalizeOutlookEvent("primary", { ...base, isOrganizer: true, organizer: { emailAddress: { address: OWNER } }, attendees: [] }, OWNER)!;
    expect(mine.attendees).toEqual([]);
    expect(normalizeOutlookEvent("primary", { ...base, isCancelled: true }, OWNER)!.status).toBe("cancelled");
    expect(normalizeOutlookEvent("primary", { ...base, start: { dateTime: "2026-11-18T09:00:00", timeZone: "W. Europe Standard Time" } }, OWNER)).toBeNull();
  });

  it("keeps an online meeting as a flag and never its join link", () => {
    const e3 = (GRAPH_FIXTURES.deltaFirstPage2!.value as Record<string, unknown>[])[1]!;
    const event = normalizeOutlookEvent("primary", e3, OWNER)!;
    expect(event.onlineMeeting).toBe(true);
    const page = renderCalendarEvent(ctx("outlook_calendar"), event);
    expect(page.body).toContain("Online meeting: yes");
    expect(page.body).toContain("Quarterly check-in.");
    expect(page.body).not.toContain("teams.microsoft.com");
    expect(page.body).not.toContain("meetup-join");
    expect(JSON.stringify(page.truth)).not.toContain("teams.microsoft.com");
  });

  it("renders an Outlook event byte for byte like the same event from Google Calendar", () => {
    const outlook = {
      id: "AAMkGolden=", type: "singleInstance", iCalUId: "golden-0001@example.test", subject: "Budget review",
      body: { contentType: "html", content: "<p>Bring the numbers.</p>" },
      start: { dateTime: "2026-12-01T14:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-12-01T15:00:00.0000000", timeZone: "UTC" },
      isAllDay: false, isCancelled: false, isOrganizer: false, responseRequested: true, responseStatus: { response: "notResponded" },
      location: { displayName: "Room 2" },
      organizer: { emailAddress: { name: "Dan Park", address: "dan@example.org" } },
      attendees: [
        { type: "required", status: { response: "tentativelyAccepted" }, emailAddress: { name: "Ana Lee", address: "ana@example.net" } },
        { type: "required", status: { response: "none" }, emailAddress: { name: "Owner Example", address: OWNER } },
      ],
    };
    const google = {
      id: "golden0001", iCalUID: "golden-0001@example.test", status: "confirmed", summary: "Budget review",
      description: "<p>Bring the numbers.</p>", location: "Room 2",
      start: { dateTime: "2026-12-01T15:00:00+01:00" }, end: { dateTime: "2026-12-01T15:00:00Z" },
      organizer: { email: "dan@example.org", displayName: "Dan Park" },
      attendees: [
        { email: "ana@example.net", displayName: "Ana Lee", responseStatus: "tentative" },
        { email: OWNER, displayName: "Owner Example", responseStatus: "needsAction", self: true },
      ],
    };
    const o = renderCalendarEvent(ctx("outlook_calendar"), normalizeOutlookEvent("primary", outlook, OWNER)!);
    const g = renderCalendarEvent(ctx("google_calendar"), normalizeGoogleEvent("primary", google)!);
    expect(o.slug).toBe(g.slug);
    expect(o.title).toBe(g.title);
    expect(o.body).toBe(g.body);
    const { connector: oc, external_id: oe, ...oRest } = o.truth;
    const { connector: gc, external_id: ge, ...gRest } = g.truth;
    expect([oc, gc]).toEqual(["outlook_calendar", "google_calendar"]);
    expect(oe).not.toBe(ge);
    expect(oRest).toEqual(gRest);
    // The open-loop detector reads the same reply state from both.
    expect(o.loop).toEqual(g.loop);
  });

  it("renders an Outlook series like the same Google series, occurrences included", () => {
    const master = GRAPH_FIXTURES.seriesS1Master!;
    const occurrences = [
      { start: "2026-11-09T08:00:00.000Z", end: "2026-11-09T08:30:00.000Z", status: "confirmed" as const },
      { start: "2026-11-16T08:00:00.000Z", end: "2026-11-16T08:30:00.000Z", status: "confirmed" as const },
    ];
    const google = {
      id: "s1", iCalUID: master.iCalUId, status: "confirmed", summary: "Weekly sync", description: "<p>Status round.</p>",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      start: { dateTime: "2023-11-06T08:00:00Z" }, end: { dateTime: "2023-11-06T08:30:00Z" },
      organizer: { email: "ana@example.net", displayName: "Ana Lee" },
      attendees: [{ email: OWNER, displayName: "Owner Example", responseStatus: "accepted" }],
    };
    const o = renderCalendarEvent(ctx("outlook_calendar"), normalizeOutlookEvent("primary", master, OWNER, { list: occurrences, truncated: false })!);
    const g = renderCalendarEvent(ctx("google_calendar"), normalizeGoogleEvent("primary", google, { list: occurrences, truncated: false })!);
    expect(o.body).toBe(g.body);
    expect(o.body).toContain("Repeats: RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  it("names calendar streams by hash and reads a stored cursor, refusing anything malformed", () => {
    const adapter = outlookCalendarAdapter(syncAccount({ calendars: [TEAM] }));
    const streams = adapter.streams(syncAccount());
    expect(streams).toEqual([outlookCalendarStream("primary"), outlookCalendarStream(TEAM)]);
    expect(streams.join(" ")).not.toContain(TEAM);
    expect(outlookCalendarAdapter(syncAccount({}, [])).streams(syncAccount({}, []))).toEqual([]);

    const pass = { v: 1, mode: "full", timeMin: "2026-08-18T10:00:00.000Z", timeMax: "2027-02-14T10:00:00.000Z", link: SKIP_PATH, atRest: false, since: null, listedAt: null };
    expect(parseOutlookCursor(JSON.stringify(pass))).toEqual(pass as never);
    for (const bad of [
      "{not json", "plain-token", JSON.stringify({ ...pass, v: 2 }), JSON.stringify({ ...pass, mode: "x" }),
      JSON.stringify({ ...pass, link: "https://graph.microsoft.com/v1.0/me" }), JSON.stringify({ ...pass, link: "//evil.example/x" }),
      JSON.stringify({ ...pass, timeMin: "soon" }), JSON.stringify({ ...pass, mode: "delta", link: null }),
      JSON.stringify({ ...pass, link: `/v1.0/${"x".repeat(20_000)}` }),
    ]) expect(parseOutlookCursor(bad)).toBeNull();
    expect(parseOutlookCursor(null)).toBeNull();
  });

  it("lists the owner's own calendars, default first, and leaves out ones others share (Calendars.Read cannot read them)", async () => {
    const w: GraphWorld = { calls: [], delta: () => "deltaEmpty" };
    const client = new ConnectorClient({ origin: "https://graph.microsoft.com", token: GRAPH_ACCESS_TOKEN, fetch: graphFetch(w), sleep: async () => {} });
    expect(await listOutlookCalendars(client, OWNER)).toEqual([
      { id: "AAMkCalDefault01=", summary: "Calendar", primary: true, accessRole: "writer" },
      { id: TEAM, summary: "Team", primary: false, accessRole: "reader" },
    ]);
  });

  it("waits out a 429 for as long as Retry-After asks, and stops rate_limited when it does not clear", async () => {
    let refusals = 1;
    const w: GraphWorld = {
      calls: [],
      delta: () => (refusals-- > 0 ? { status: 429, retryAfter: "7", body: GRAPH_FIXTURES.errorThrottled! } : "deltaEmpty"),
    };
    const sleeps: number[] = [];
    const client = new ConnectorClient({
      origin: "https://graph.microsoft.com", token: GRAPH_ACCESS_TOKEN, fetch: graphFetch(w), minSpacingMs: 0, sleep: async ms => { sleeps.push(ms); },
    });
    const cursor = JSON.stringify({ v: 1, mode: "delta", timeMin: "2026-08-18T10:00:00.000Z", timeMax: "2027-02-14T10:00:00.000Z", link: DELTA_ONE, atRest: true, since: null, listedAt: new Date(T0).toISOString() });
    const ok = await outlookCalendarAdapter(syncAccount(), { now: () => T0 }).page({ client, account: syncAccount(), stream: outlookCalendarStream("primary"), cursor, page: 0 });
    expect(ok.ok).toBe(true);
    expect(sleeps).toEqual([7000]);

    refusals = 100;
    const stuck = await outlookCalendarAdapter(syncAccount(), { now: () => T0 }).page({ client, account: syncAccount(), stream: outlookCalendarStream("primary"), cursor, page: 0 });
    expect(stuck.ok).toBe(false);
    if (!stuck.ok) expect(stuck.response.class).toBe("rate_limited");
  });
});

const count = async (e: Engine, sql: string, params: unknown[] = []) =>
  Number((await e.query<{ n: number }>(sql, params)).rows[0]!.n);
const live = (e: Engine, slug: string) => count(e, `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [slug]);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outlook calendar sync (${name})`, () => {
  function providers(): ProviderRegistry {
    const r = new ProviderRegistry();
    r.register(microsoftProvider());
    return r;
  }

  async function connect(storage: Storage, world: GraphWorld, env: NodeJS.ProcessEnv = ENV): Promise<ConnectorAccount> {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "calendar", pathPrefix: "calendar/" });
    const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: graphFetch(world), env, now: () => T0 };
    const started = await startConnect(deps, {
      provider: "microsoft", sourceId: SOURCE, services: ["outlook_calendar"], principalRef: "admin:operator", adminSessionId: SESSION,
      redirectUri: connectorCallbackUri("https://brain.example.test", "microsoft"),
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const { account } = await completeConnect(deps, { provider: "microsoft", state, code: "M.C512_test-auth-code", adminSessionId: SESSION });
    await setAccountEnabled(e, account.id, true);
    return (await getAccount(e, account.id))!;
  }

  async function run(storage: Storage, world: GraphWorld, accountId: string, env: NodeJS.ProcessEnv = ENV, at: number = T0) {
    const rt = connectorRuntime(storage, {
      kek, providers: providers(), fetch: graphFetch(world), env, now: () => at, sleep: async () => {}, embedFn: async (t: string) => deterministicEmbed(t),
    });
    const account = (await rt.loadAccount(accountId))!;
    return runConnectorSync(storage, account, rt.depsFor(account));
  }

  async function cursor(e: Engine, accountId: string, calendar = "primary") {
    return parseOutlookCursor(await readCursor(e, accountId, outlookCalendarStream(calendar)));
  }

  it("connects over PKCE asking only for Calendars.Read, and accepts Graph's answer of the grant", async () => {
    const db = await open();
    try {
      const world = firstSyncWorld();
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "calendar", pathPrefix: "calendar/" });
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: graphFetch(world), env: ENV, now: () => T0 };
      const started = await startConnect(deps, {
        provider: "microsoft", sourceId: SOURCE, services: ["outlook_calendar"], principalRef: "admin:operator", adminSessionId: SESSION,
        redirectUri: connectorCallbackUri("https://brain.example.test", "microsoft"),
      });
      const url = new URL(started.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
      expect(url.searchParams.get("client_id")).toBe(ENV.MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID!);
      expect(url.searchParams.get("scope")).toBe("openid email offline_access User.Read Calendars.Read");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("response_mode")).toBe("query");
      expect(url.searchParams.get("prompt")).toBe("select_account");

      const { account } = await completeConnect(deps, {
        provider: "microsoft", state: url.searchParams.get("state"), code: "M.C512_test-auth-code", adminSessionId: SESSION,
      });
      expect(account.account_label).toBe(OWNER);
      expect(account.enabled).toBe(false);
      const exchange = world.calls.find(c => c.url.toString() === MS_TOKEN_URL)!;
      expect(exchange.body?.get("code_verifier")).toMatch(/^[\w-]{43}$/);
      expect(exchange.body?.get("client_secret")).toBe(ENV.MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET!);
    } finally { await db.close(); }
  });

  it("disconnects without a revocation endpoint: the credential is deleted, nothing is sent to Microsoft", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      world.calls.length = 0;
      const deps: ConnectDeps = { engine: e, kek, providers: providers(), fetch: graphFetch(world), env: ENV, now: () => T0 };
      expect(await disconnectAccount(deps, account.id)).toEqual({ revoked: false, credentialKept: false });
      expect(world.calls).toEqual([]);
      expect((await getAccount(e, account.id))!.status).toBe("revoked");
      expect(await count(e, "SELECT count(*)::int AS n FROM connector_credentials WHERE account_id = $1", [account.id])).toBe(0);
    } finally { await db.close(); }
  });

  it("refuses a grant that carries write access, and says it could not revoke it", async () => {
    const db = await open();
    try {
      const world = { ...firstSyncWorld(), grantedScope: "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read openid profile email" };
      const err = await connect(db.storage, world).catch(e => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe("scope_mismatch");
      expect(await count(db.storage.engine(), "SELECT count(*)::int AS n FROM connector_accounts")).toBe(0);
    } finally { await db.close(); }
  });

  it("first sync: windows the delta, commits the delta link after the last page, renders series and links attendees", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      const { putPage } = await import("../src/core/pages.ts");
      await putPage(db.storage, { slug: "people/ana-lee", markdown_body: "Ana.", compiled_truth: { aliases: ["ana@example.net"] } });
      world.calls.length = 0;

      const result = await run(db.storage, world, account.id);
      expect(result.status).toBe("success");
      const calls = deltaCalls(world);
      expect(calls).toHaveLength(2);
      expect(Date.parse(calls[0]!.url.searchParams.get("startDateTime")!)).toBe(T0 - 90 * DAY);
      expect(Date.parse(calls[0]!.url.searchParams.get("endDateTime")!)).toBe(T0 + 90 * DAY);
      expect(calls[1]!.url.searchParams.get("$skiptoken")).toBe("skip-page-2");
      expect(calls[1]!.url.searchParams.get("startDateTime")).toBeNull();
      for (const c of world.calls.filter(c => c.url.origin === "https://graph.microsoft.com")) expect(c.prefer).toBe(OUTLOOK_PREFER);
      expect(await cursor(e, account.id)).toMatchObject({ mode: "delta", link: DELTA_ONE, atRest: true, listedAt: new Date(T0).toISOString() });

      const single = (await e.query<{ title: string; markdown_body: string; compiled_truth: Record<string, unknown> }>(
        `SELECT title, markdown_body, compiled_truth FROM pages WHERE slug = $1 AND source_id = $2`, [E1, SOURCE])).rows[0]!;
      expect(single.title).toBe("Roadmap review");
      expect(single.compiled_truth).toMatchObject({ origin: "connector", trust: "untrusted", connector: "outlook_calendar", external_id: eventKey("AAMkE1single=") });
      expect(single.markdown_body).toContain("Agenda: review the roadmap.");
      expect(single.markdown_body).toContain("Ana Lee <ana@example.net> (accepted)");
      expect(single.markdown_body).toContain("Owner Example <owner@example.test> (needsAction)");
      expect(single.markdown_body).not.toContain("resource.example.test");
      const links = (await e.query<{ target_slug: string; type: string }>(`SELECT target_slug, type FROM links WHERE source_slug = $1`, [E1])).rows;
      expect(links).toEqual([{ target_slug: "people/ana-lee", type: "attended" }]);
      const state = (await e.query<{ kind: string; signals: Record<string, unknown> }>(`SELECT kind, signals FROM loop_threads WHERE page_slug = $1`, [E1])).rows;
      expect(state).toEqual([expect.objectContaining({ kind: "calendar", signals: expect.objectContaining({ myResponse: "needsaction", organizerMine: false }) })]);

      const series = (await e.query<{ markdown_body: string; compiled_truth: Record<string, unknown> }>(
        `SELECT markdown_body, compiled_truth FROM pages WHERE slug = $1`, [S1])).rows[0]!;
      expect(series.markdown_body).toContain("Repeats: RRULE:FREQ=WEEKLY;BYDAY=MO");
      expect(series.markdown_body).toContain("2026-11-09T08:00:00.000Z");
      expect(series.markdown_body).toContain("2026-11-23T09:00:00.000Z");
      // A cancelled occurrence is not listed.
      expect(series.markdown_body).not.toContain("2026-11-30");
      expect(series.compiled_truth.last_activity_at).toBe("2026-11-23T09:30:00.000Z");
      // Two occurrences named the series; it was fetched once.
      expect(world.calls.filter(c => c.url.pathname === `/v1.0/me/events/${encodeURIComponent("AAMkS1master=")}`)).toHaveLength(1);
      const inst = world.calls.find(c => c.url.pathname.endsWith("/instances"))!;
      expect(Date.parse(inst.url.searchParams.get("startDateTime")!)).toBe(T0 - 90 * DAY);
      expect(Date.parse(inst.url.searchParams.get("endDateTime")!)).toBe(T0 + 90 * DAY);

      const allday = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [E2])).rows[0]!;
      expect(allday.markdown_body).toContain("When: 2026-11-20 to 2026-11-21");
      const online = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE slug = $1`, [E3])).rows[0]!;
      expect(online.markdown_body).toContain("Online meeting: yes");
      expect(online.markdown_body).not.toContain("teams.microsoft.com");
      expect(JSON.stringify(result)).not.toContain(GRAPH_ACCESS_TOKEN);
      expect(JSON.stringify(result)).not.toContain(OWNER);
    } finally { await db.close(); }
  });

  it("keeps the next link, never a delta link, when a pass stops part-way, and resumes from it", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      world.delta = (_cal, q) => (q.get("$skiptoken") === "skip-page-2" ? { status: 429, retryAfter: "3600", body: GRAPH_FIXTURES.errorThrottled! } : "deltaFirstPage1");
      const stopped = await run(db.storage, world, account.id);
      expect(stopped.status).toBe("partial");
      expect(await cursor(e, account.id)).toMatchObject({ mode: "full", link: SKIP_PATH, atRest: false });

      world.calls.length = 0;
      world.delta = firstSyncWorld().delta;
      const resumed = await run(db.storage, world, account.id);
      expect(resumed.status).toBe("success");
      expect(deltaCalls(world).map(c => c.url.searchParams.get("$skiptoken"))).toEqual(["skip-page-2"]);
      expect(await cursor(e, account.id)).toMatchObject({ mode: "delta", link: DELTA_ONE, atRest: true });
      expect(await live(e, E2)).toBe(1);
    } finally { await db.close(); }
  });

  it("a delta round updates a moved event, deletes a cancelled one and a removed one, and closes nothing it should not", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      expect((await run(db.storage, world, account.id)).status).toBe("success");
      world.calls.length = 0;

      const result = await run(db.storage, world, account.id, ENV, T1);
      expect(result.status).toBe("success");
      expect(deltaCalls(world).map(c => `${c.url.pathname}${c.url.search}`)).toEqual([DELTA_ONE]);
      expect(result.counts.deletions_applied).toBe(2);
      expect(await live(e, E2)).toBe(0);
      expect(await live(e, E3)).toBe(0);
      const moved = (await e.query<{ title: string; markdown_body: string }>(`SELECT title, markdown_body FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [E1])).rows[0]!;
      expect(moved.title).toBe("Roadmap review (moved)");
      expect(moved.markdown_body).toContain("2026-11-19T09:00:00.000Z");
      expect(await live(e, S1)).toBe(1);
      expect(await cursor(e, account.id)).toMatchObject({ mode: "delta", link: "/v1.0/me/calendarView/delta?$deltatoken=delta-two", atRest: true });
    } finally { await db.close(); }
  });

  for (const lost of [
    { label: "410 Gone", answer: { status: 410, body: { error: { code: "resyncRequired", message: "Resync required." } } } },
    { label: "syncStateNotFound", answer: { status: 400, body: GRAPH_FIXTURES.errorSyncStateNotFound! } },
  ]) {
    it(`a lost sync state (${lost.label}) re-lists a fresh window and deletes what the listing no longer has`, async () => {
      const db = await open();
      try {
        const e = db.storage.engine();
        const world = firstSyncWorld();
        const account = await connect(db.storage, world);
        expect((await run(db.storage, world, account.id)).status).toBe("success");
        world.calls.length = 0;
        world.delta = (_cal, q) => (q.get("$deltatoken") === "delta-one" ? lost.answer : "deltaRelistOnly");

        const result = await run(db.storage, world, account.id, ENV, T1);
        expect(result.status).toBe("success");
        const calls = deltaCalls(world);
        expect(calls.map(c => c.url.searchParams.get("$deltatoken"))).toEqual(["delta-one", null]);
        // The floor stays the first sync's; the horizon moves with the clock.
        expect(Date.parse(calls[1]!.url.searchParams.get("startDateTime")!)).toBe(T0 - 90 * DAY);
        expect(Date.parse(calls[1]!.url.searchParams.get("endDateTime")!)).toBe(T1 + 90 * DAY);
        expect(result.counts.deletions_applied).toBe(3);
        expect(await live(e, E1)).toBe(1);
        for (const gone of [E2, E3, S1]) expect(await live(e, gone)).toBe(0);
        expect(await cursor(e, account.id)).toMatchObject({ mode: "delta", link: "/v1.0/me/calendarView/delta?$deltatoken=delta-three", listedAt: new Date(T1).toISOString() });
      } finally { await db.close(); }
    });
  }

  it("re-lists once a week so the window's horizon keeps moving", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      expect((await run(db.storage, world, account.id)).status).toBe("success");
      world.calls.length = 0;
      world.delta = () => "deltaEmpty";
      const later = T0 + 8 * DAY;
      expect((await run(db.storage, world, account.id, ENV, later)).status).toBe("success");
      const calls = deltaCalls(world);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.searchParams.get("$deltatoken")).toBeNull();
      expect(Date.parse(calls[0]!.url.searchParams.get("endDateTime")!)).toBe(later + 90 * DAY);
      expect(await cursor(e, account.id)).toMatchObject({ link: "/v1.0/me/calendarView/delta?$deltatoken=delta-empty", listedAt: new Date(later).toISOString() });
    } finally { await db.close(); }
  });

  it("a selected secondary calendar is re-listed through the v1.0 calendar view at most hourly, and what it no longer lists goes", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      await setAccountConfig(e, account.id, { calendars: [TEAM] });
      const E4 = pageSlug("040000008200E00074C5B7101A82E0080000000006E4");
      const views = () => world.calls.filter(c => c.url.pathname === `/v1.0/me/calendars/${encodeURIComponent(TEAM)}/calendarView`);
      world.view = () => "secondaryView";

      expect((await run(db.storage, world, account.id)).status).toBe("success");
      expect(views()).toHaveLength(1);
      expect(Date.parse(views()[0]!.url.searchParams.get("startDateTime")!)).toBe(T0 - 90 * DAY);
      expect(Date.parse(views()[0]!.url.searchParams.get("endDateTime")!)).toBe(T0 + 90 * DAY);
      // Never the per-calendar delta, which v1.0 does not document.
      expect(world.calls.some(c => c.url.pathname.includes("/calendars/") && c.url.pathname.endsWith("/delta"))).toBe(false);
      expect(await live(e, E4)).toBe(1);
      expect((await e.query<{ compiled_truth: Record<string, unknown> }>(`SELECT compiled_truth FROM pages WHERE slug = $1`, [E4])).rows[0]!.compiled_truth)
        .toMatchObject({ connector: "outlook_calendar", external_id: eventKey("AAMkE4team=", TEAM) });

      world.calls.length = 0;
      expect((await run(db.storage, world, account.id, ENV, T0 + 30 * 60_000)).status).not.toBe("failed");
      expect(views()).toHaveLength(0);

      world.view = () => "secondaryViewEmpty";
      const later = await run(db.storage, world, account.id, ENV, T0 + 2 * 3_600_000);
      expect(views()).toHaveLength(1);
      expect(later.counts.deletions_applied).toBe(1);
      expect(await live(e, E4)).toBe(0);
      // The default calendar's events are untouched by the secondary's reconcile.
      expect(await live(e, E1)).toBe(1);
    } finally { await db.close(); }
  });

  it("a selected calendar Graph no longer has is one failing item; the default calendar still syncs", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      await setAccountConfig(e, account.id, { calendars: [TEAM] });
      const inner = world.delta;
      world.delta = inner;
      world.view = () => ({ status: 404, body: GRAPH_FIXTURES.errorItemNotFound! });
      const result = await run(db.storage, world, account.id);
      expect(result.counts.items_failed).toBe(1);
      expect(world.calls.some(c => c.url.pathname === `/v1.0/me/calendars/${encodeURIComponent(TEAM)}/calendarView`)).toBe(true);
      expect(await live(e, E1)).toBe(1);
      expect(await cursor(e, account.id)).toMatchObject({ link: DELTA_ONE });
    } finally { await db.close(); }
  });

  it("a refused refresh parks the account for a reconnect and leaves its cursor where it was", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const world = firstSyncWorld();
      const account = await connect(db.storage, world);
      expect((await run(db.storage, world, account.id)).status).toBe("success");
      const before = await readCursor(e, account.id, outlookCalendarStream("primary"));
      // The access token is past its hour and Microsoft refuses the refresh token.
      world.refuseRefresh = true;
      const result = await run(db.storage, world, account.id, ENV, T0 + 2 * 3_600_000);
      expect(result.stop_reason).toBe("needs_reconnect");
      expect((await getAccount(e, account.id))!.status).toBe("needs_reconnect");
      expect(await readCursor(e, account.id, outlookCalendarStream("primary"))).toBe(before);
    } finally { await db.close(); }
  });
});
