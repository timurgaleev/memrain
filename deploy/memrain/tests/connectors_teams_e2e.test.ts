/**
 * Microsoft Teams end to end, on both engines, through the real runtime,
 * sync engine and renderers against a fake Graph: Teams chats land as
 * untrusted chat pages in their own chat source, transcripts as meeting
 * pages in their own meeting source, each with meeting credentials removed;
 * a transcript page links the calendar event page by its slug; and a second
 * run does not read a stored transcript again. No request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/vault.ts";
import { createAccount, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { microsoftProvider } from "../src/core/connectors/microsoft/provider.ts";
import { calendarEventSlug } from "../src/core/connectors/microsoft/teams-transcripts.ts";
import { PROVIDER_USER_ID } from "../src/core/connectors/model.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const ACCESS = ["acc", "ess", "-teams-e2e"].join("");
const REFRESH = ["ref", "resh", "-teams-e2e"].join("");
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-4000-8000-00000000c11e",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-ms-client-secret-value",
};
const CHAT = "19:chat-e2e@thread.v2";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_e2e%40thread.v2/0?context=%7b%7d";

const message = (id: string, created: string, text: string) => ({
  id, messageType: "message", createdDateTime: created, lastModifiedDateTime: created, deletedDateTime: null, replyToId: null,
  from: { user: { id: "user-ada", displayName: "Ada" }, application: null }, body: { contentType: "text", content: text },
});

function fakeGraph(paths: string[]): FetchFn {
  return async (raw) => {
    const url = new URL(raw);
    paths.push(url.pathname);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/v1.0/me/chats":
        return json({ value: [{ id: CHAT, chatType: "group", topic: "Budget", lastMessagePreview: { createdDateTime: "2026-11-16T09:00:00.000Z" } }] });
      case `/v1.0/chats/${encodeURIComponent(CHAT)}/messages`:
        return json({ value: [message("m1", "2026-11-16T09:00:00.000Z", "Dial in, Passcode: 739215")] });
      case "/v1.0/me/calendarView":
        return json({
          value: [{
            id: "ev-1", iCalUId: "ical-e2e", subject: "Budget review", type: "singleInstance", isCancelled: false,
            start: { dateTime: "2026-11-15T14:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-15T15:00:00.0000000", timeZone: "UTC" },
            onlineMeeting: { joinUrl: JOIN }, organizer: { emailAddress: { name: "Ada", address: "ada@example.test" } }, attendees: [],
          }],
        });
      case "/v1.0/me/onlineMeetings":
        return json({ value: [{ id: "meeting-e2e" }] });
      case "/v1.0/me/onlineMeetings/meeting-e2e/transcripts":
        return json({ value: [{ id: "tr-e2e", createdDateTime: "2026-11-15T14:01:00Z", endDateTime: "2026-11-15T14:59:00Z" }] });
      case "/v1.0/me/onlineMeetings/meeting-e2e/transcripts/tr-e2e/content":
        return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ada>Numbers look fine, Passcode: 739215</v>\n", { status: 200, headers: { "content-type": "text/vtt" } });
      default:
        throw new Error(`unexpected request ${url.pathname}`);
    }
  };
}

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`Teams connector (${name})`, () => {
  it("writes chats and transcripts into their own sources, redacted, the transcript linked to its calendar event", async () => {
    const db = await open();
    try {
      const e: Engine = db.storage.engine();
      await registerSource(e, { id: "work-teams", kind: "chat", pathPrefix: "chat/" });
      await registerSource(e, { id: "work-transcripts", kind: "meeting", pathPrefix: "meeting/" });
      const providers = new ProviderRegistry();
      providers.register(microsoftProvider());
      const paths: string[] = [];
      const run = async (accountId: string) => {
        const rt = connectorRuntime(db.storage, {
          kek, providers, fetch: fakeGraph(paths), env: ENV, now: () => T0, sleep: async () => {}, embedFn: async (t: string) => deterministicEmbed(t),
        });
        const loaded = (await rt.loadAccount(accountId))!;
        return runConnectorSync(db.storage, loaded, rt.depsFor(loaded));
      };
      const connect = async (sourceId: string, service: string, scopes: string[]) => {
        const account = await createAccount(e, {
          sourceId, provider: "microsoft", services: [service], principalRef: "admin:operator", accountLabel: OWNER, config: { [PROVIDER_USER_ID]: "user-self" },
        });
        await storeCredential(e, kek, account, { access_token: ACCESS, refresh_token: REFRESH }, { scopes: [...scopes, "User.Read", "offline_access"], expiresAt: new Date(T0 + 3_000_000) });
        await setAccountEnabled(e, account.id, true);
        return account.id;
      };

      const chatAccount = await connect("work-teams", "teams_chat", ["Chat.Read"]);
      expect((await run(chatAccount)).status).toBe("success");
      const chatPages = (await e.query<{ slug: string; type: string; source_id: string; compiled_truth: string; body: string }>(
        `SELECT slug, type, source_id, compiled_truth::text AS compiled_truth, markdown_body AS body FROM pages WHERE source_id = 'work-teams' AND deleted_at IS NULL`,
      )).rows;
      expect(chatPages).toHaveLength(1);
      expect(chatPages[0]!.type).toBe("connector-chat");
      expect(chatPages[0]!.compiled_truth).toContain("untrusted");
      expect(chatPages[0]!.body).not.toContain("739215");

      const txAccount = await connect("work-transcripts", "teams_transcripts", ["Calendars.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]);
      expect((await run(txAccount)).status).toBe("success");
      const meeting = (await e.query<{ slug: string; type: string; body: string; compiled_truth: string }>(
        `SELECT slug, type, markdown_body AS body, compiled_truth::text AS compiled_truth FROM pages WHERE source_id = 'work-transcripts' AND deleted_at IS NULL`,
      )).rows;
      expect(meeting).toHaveLength(1);
      expect(meeting[0]!.type).toBe("connector-meeting");
      expect(meeting[0]!.body).toContain("Ada: Numbers look fine");
      expect(meeting[0]!.body).not.toContain("739215");
      const eventSlug = calendarEventSlug(OWNER, "ical-e2e");
      expect(meeting[0]!.compiled_truth).toContain(eventSlug);
      const edge = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM links WHERE source_slug = $1 AND target_slug = $2`, [meeting[0]!.slug, eventSlug]);
      expect(edge.rows[0]!.n).toBe(1);
      // Nothing of either kind reached the other's source.
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND type LIKE 'connector-%'`)).rows[0]!.n)).toBe(0);

      paths.length = 0;
      expect((await run(txAccount)).status).toBe("nothing_new");
      expect(paths.some(p => p.endsWith("/content"))).toBe(false);
    } finally { await db.close(); }
  });
});
