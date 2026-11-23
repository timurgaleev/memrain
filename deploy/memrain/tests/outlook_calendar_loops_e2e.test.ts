/**
 * Outlook calendar into open loops, end to end: a recorded Microsoft 365
 * calendar goes through the real connector sync (adapter, renderer, runtime)
 * and the loop sweep, on both engines. An invitation the owner has not
 * answered (Graph's `notResponded` in the event's own responseStatus, while
 * the owner's attendee entry says `none`) opens an RSVP-owed loop to its
 * organizer, exactly as Google Calendar's needsAction does; an accepted
 * meeting, the owner's own event and an accepted series open nothing; once
 * the owner accepts, the next delta round closes the loop.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GRAPH_ACCESS_TOKEN, GRAPH_FIXTURES, GRAPH_REFRESH_TOKEN, graphFetch, type GraphWorld } from "./helpers/graph-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/vault.ts";
import { createAccount, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { MICROSOFT_CALENDARS_READ, microsoftProvider } from "../src/core/connectors/microsoft/provider.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import { listLoops, sweepLoops } from "../src/core/loops/store.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "cal";
const OWNER = "owner@example.test";
/** A sign-in name that receives no mail: the tenant's UPN differs from the mailbox address. */
const UPN = "o.wner@corp.example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-4000-8000-00000000c11e",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-ms-client-secret-value",
};

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outlook calendar to open loops (${name})`, () => {
  it("an unanswered invitation opens rsvp_owed to its organizer; accepting it closes the loop", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "calendar", pathPrefix: "calendar/" });
      const account = await createAccount(e, { sourceId: SOURCE, provider: "microsoft", services: ["outlook_calendar"], principalRef: "admin:operator", accountLabel: OWNER });
      await storeCredential(e, kek, account, { access_token: GRAPH_ACCESS_TOKEN, refresh_token: GRAPH_REFRESH_TOKEN }, {
        scopes: [MICROSOFT_CALENDARS_READ, "User.Read", "email", "offline_access", "openid"], expiresAt: new Date(T0 + 3_000_000),
      });
      await setAccountEnabled(e, account.id, true);

      const providers = new ProviderRegistry();
      providers.register(microsoftProvider());
      const w: GraphWorld = {
        calls: [],
        delta: (_cal, q) => (q.get("$skiptoken") === "skip-page-2" ? "deltaFirstPage2" : q.get("$deltatoken") === "delta-one" ? "deltaChanges" : "deltaFirstPage1"),
        event: (_cal, id) => (id === "AAMkS1master=" ? "seriesS1Master" : { status: 404, body: GRAPH_FIXTURES.errorItemNotFound! }),
        instances: () => "instancesS1",
      };
      const sync = async () => {
        const rt = connectorRuntime(db.storage, {
          kek, providers, fetch: graphFetch(w), env: ENV, now: () => T0, sleep: async () => {}, embedFn: async (t: string) => deterministicEmbed(t),
        });
        const loaded = (await rt.loadAccount(account.id))!;
        return runConnectorSync(db.storage, loaded, rt.depsFor(loaded));
      };

      expect((await sync()).status).toBe("success");
      // Roadmap review, the offsite, the vendor sync and the weekly series.
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM loop_threads WHERE source_id = $1`, [SOURCE])).rows[0]!.n)).toBe(4);

      expect(await sweepLoops(e, SOURCE, new Date(T0))).toMatchObject({ threads: 4, opened: 1 });
      const open1 = (await listLoops(e, [SOURCE])).map(l => [l.loop_type, l.counterparty]);
      expect(open1).toEqual([["rsvp_owed", "Dan Park <dan@example.org>"]]);

      // The owner accepts in Outlook; the next round reports the event with its new answer.
      expect((await sync()).status).toBe("success");
      const swept = await sweepLoops(e, SOURCE, new Date(T0 + 60_000));
      expect(swept.closed).toBeGreaterThanOrEqual(1);
      expect(await listLoops(e, [SOURCE])).toEqual([]);
    } finally { await db.close(); }
  });

  it("a work account labelled by a UPN that is not its mail address answers as that address, listed once", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "calendar", pathPrefix: "calendar/" });
      const account = await createAccount(e, { sourceId: SOURCE, provider: "microsoft", services: ["outlook_calendar"], principalRef: "admin:operator", accountLabel: UPN,
        config: { mailbox_address: OWNER } });
      await storeCredential(e, kek, account, { access_token: GRAPH_ACCESS_TOKEN, refresh_token: GRAPH_REFRESH_TOKEN }, {
        scopes: [MICROSOFT_CALENDARS_READ, "User.Read", "email", "offline_access", "openid"], expiresAt: new Date(T0 + 3_000_000),
      });
      await setAccountEnabled(e, account.id, true);

      const providers = new ProviderRegistry();
      providers.register(microsoftProvider());
      const w: GraphWorld = {
        calls: [],
        delta: (_cal, q) => (q.get("$skiptoken") === "skip-page-2" ? "deltaFirstPage2" : q.get("$deltatoken") === "delta-one" ? "deltaChanges" : "deltaFirstPage1"),
        event: (_cal, id) => (id === "AAMkS1master=" ? "seriesS1Master" : { status: 404, body: GRAPH_FIXTURES.errorItemNotFound! }),
        instances: () => "instancesS1",
      };
      const sync = async () => {
        const rt = connectorRuntime(db.storage, {
          kek, providers, fetch: graphFetch(w), env: ENV, now: () => T0, sleep: async () => {}, embedFn: async (t: string) => deterministicEmbed(t),
        });
        const loaded = (await rt.loadAccount(account.id))!;
        return runConnectorSync(db.storage, loaded, rt.depsFor(loaded));
      };

      expect((await sync()).status).toBe("success");
      // Roadmap review, the offsite, the vendor sync and the weekly series.
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM loop_threads WHERE source_id = $1`, [SOURCE])).rows[0]!.n)).toBe(4);

      expect(await sweepLoops(e, SOURCE, new Date(T0))).toMatchObject({ threads: 4, opened: 1 });
      const open1 = (await listLoops(e, [SOURCE])).map(l => [l.loop_type, l.counterparty]);
      expect(open1).toEqual([["rsvp_owed", "Dan Park <dan@example.org>"]]);
      // The owner is the attendee Graph lists under the mailbox address, never added again under the sign-in name.
      const bodies = (await e.query<{ markdown_body: string }>(`SELECT markdown_body FROM pages WHERE source_id = $1`, [SOURCE])).rows;
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) expect(b.markdown_body).not.toContain(UPN);

      // The owner accepts in Outlook; the next round reports the event with its new answer.
      expect((await sync()).status).toBe("success");
      const swept = await sweepLoops(e, SOURCE, new Date(T0 + 60_000));
      expect(swept.closed).toBeGreaterThanOrEqual(1);
      expect(await listLoops(e, [SOURCE])).toEqual([]);
    } finally { await db.close(); }
  });
});
