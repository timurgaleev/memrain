/**
 * Gmail into open loops, end to end: a recorded mailbox goes through the real
 * connector sync (adapter, renderer, runtime) and the loop sweep, on both
 * engines. A question someone sent the account opens a reply-owed loop; a
 * question the account sent from an alias opens a waiting-on loop through
 * Gmail's SENT label; a newsletter, a no-reply Reply-To mailing and a calendar
 * invitation each ask a question and open nothing.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { gmailFetch, plainMessage, type GmailWorld, type RawMessage } from "./helpers/gmail-fake.ts";
import { GOOGLE_ACCESS_TOKEN } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { GOOGLE_GMAIL_READONLY, googleProvider } from "../src/core/connectors/google/provider.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import { listLoops, sweepLoops } from "../src/core/loops/store.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "mail";
const OWNER = "owner@example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const b64 = (s: string) => Buffer.from(s).toString("base64url");

function mailbox(): RawMessage[] {
  const invite = plainMessage("i1", "ti", T0 - 2 * DAY, { From: "Dan Park <dan@example.org>", To: OWNER, Subject: "Planning" }, "");
  invite.payload = {
    mimeType: "multipart/alternative",
    headers: [{ name: "From", value: "Dan Park <dan@example.org>" }, { name: "To", value: OWNER }, { name: "Subject", value: "Planning" }],
    parts: [
      { mimeType: "text/plain", body: { data: b64("Can you join the planning session?") } },
      { mimeType: "text/calendar", headers: [{ name: "Content-Type", value: "text/calendar; charset=UTF-8; method=REQUEST" }], body: { data: b64("BEGIN:VCALENDAR") } },
    ],
  };
  return [
    plainMessage("q1", "tq", T0 - 2 * DAY, { "From": "Carol Diaz <carol@example.com>", "To": OWNER, "Subject": "Venue", "Message-ID": "<q1@example.com>" },
      "Can you confirm the venue by Friday?"),
    plainMessage("o1", "to", T0 - 4 * DAY, { "From": "Owner <owner.alias@example.org>", "To": "Eve Ng <eve@example.net>", "Subject": "Contract", "Message-ID": "<o1@example.org>" },
      "Could you send the signed contract?", ["SENT"]),
    plainMessage("n1", "tn", T0 - 2 * DAY, { "From": "Shop Weekly <weekly@shop.example>", "To": OWNER, "Subject": "This week", "List-Id": "<weekly.shop.example>", "Precedence": "bulk" },
      "Did you see our new arrivals?"),
    plainMessage("r1", "tr", T0 - 2 * DAY, { "From": "Survey Team <team@survey.example>", "To": OWNER, "Reply-To": "Survey <no-reply@survey.example>", "Subject": "Quick question" },
      "How did we do?"),
    invite,
  ];
}

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail to open loops (${name})`, () => {
  it("a synced question opens a loop; a newsletter, a no-reply mailing and an invitation do not", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
      const account = await createAccount(e, { sourceId: SOURCE, provider: "google", services: ["gmail"], principalRef: "admin:operator", accountLabel: OWNER });
      await storeCredential(e, kek, account, { access_token: GOOGLE_ACCESS_TOKEN, refresh_token: "1//test-refresh" }, {
        scopes: ["email", GOOGLE_GMAIL_READONLY, "openid"], expiresAt: new Date(T0 + 3_000_000),
      });
      await setAccountEnabled(e, account.id, true);

      const providers = new ProviderRegistry();
      providers.register(googleProvider());
      const w: GmailWorld = { messages: mailbox(), profile: "profile", history: () => "historyEmpty", calls: [] };
      const rt = connectorRuntime(db.storage, {
        kek, providers, fetch: gmailFetch(w), env: ENV, now: () => T0, sleep: async () => {},
        embedFn: async (t: string) => deterministicEmbed(t),
      });
      const loaded = (await rt.loadAccount(account.id))!;
      expect((await runConnectorSync(db.storage, loaded, rt.depsFor(loaded))).status).toBe("success");
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM loop_threads WHERE source_id = $1`, [SOURCE])).rows[0]!.n)).toBe(5);

      expect(await sweepLoops(e, SOURCE, new Date(T0))).toMatchObject({ threads: 5, opened: 2 });
      const loops = (await listLoops(e, [SOURCE])).map(l => [l.loop_type, l.counterparty]).sort();
      expect(loops).toEqual([
        ["unanswered_inbound", "Carol Diaz <carol@example.com>"],
        ["unanswered_outbound", "Eve Ng <eve@example.net>"],
      ]);
    } finally { await db.close(); }
  });
});
