/**
 * Outlook into open loops, end to end: a recorded Graph mailbox goes through
 * the real connector sync (adapter, renderer, runtime) and the loop sweep, on
 * both engines. A question someone sent the account opens a reply-owed loop;
 * a question the account sent from an alias opens a waiting-on loop because
 * it sits in Sent Items; a question already answered, a newsletter (List-Id,
 * Precedence: bulk), a no-reply Reply-To mailing and a meeting request each
 * open nothing.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { GRAPH_ACCESS_TOKEN, GRAPH_REFRESH_TOKEN, outlookFetch, outlookTestProvider, outlookWorld } from "./helpers/outlook-mail-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/vault.ts";
import { createAccount, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { OUTLOOK_MAIL_SERVICE } from "../src/core/connectors/microsoft/mail.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import { listLoops, sweepLoops } from "../src/core/loops/store.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "outlook";
const OWNER = "owner@example.test";
/** A sign-in name that receives no mail: the tenant's UPN differs from the mailbox address. */
const UPN = "o.wner@corp.example.test";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID: "00000000-0000-0000-0000-00000000c0de",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outlook to open loops (${name})`, () => {
  it("a synced question opens a loop; an answered one, a newsletter, a no-reply mailing and a meeting request do not", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
      const account = await createAccount(e, { sourceId: SOURCE, provider: "microsoft", services: [OUTLOOK_MAIL_SERVICE], principalRef: "admin:operator", accountLabel: OWNER });
      await storeCredential(e, kek, account, { access_token: GRAPH_ACCESS_TOKEN, refresh_token: GRAPH_REFRESH_TOKEN }, {
        scopes: ["Mail.Read", "User.Read", "email", "offline_access", "openid"], expiresAt: new Date(T0 + 3_000_000),
      });
      await setAccountEnabled(e, account.id, true);

      const providers = new ProviderRegistry();
      providers.register(outlookTestProvider());
      const world = outlookWorld();
      // The newsletter asks a question too; bring it inside the sweep's window so it is judged.
      world.messages.find(m => m.id === "b1")!.receivedDateTime = new Date(T0 - 2 * 86_400_000).toISOString();
      const rt = connectorRuntime(db.storage, {
        kek, providers, fetch: outlookFetch(world), env: ENV, now: () => T0, sleep: async () => {},
        embedFn: async (t: string) => deterministicEmbed(t),
      });
      const loaded = (await rt.loadAccount(account.id))!;
      expect((await runConnectorSync(db.storage, loaded, rt.depsFor(loaded))).status).toBe("success");
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM loop_threads WHERE source_id = $1`, [SOURCE])).rows[0]!.n)).toBe(6);

      expect(await sweepLoops(e, SOURCE, new Date(T0))).toMatchObject({ threads: 6, opened: 2 });
      const loops = (await listLoops(e, [SOURCE])).map(l => [l.loop_type, l.counterparty]).sort();
      expect(loops).toEqual([
        ["unanswered_inbound", "Carol Diaz <carol@example.com>"],
        ["unanswered_outbound", "Eve Ng <eve@example.net>"],
      ]);
    } finally { await db.close(); }
  });

  it("a work account labelled by a UPN that is not its mail address still owes the replies sent to that address", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
      const account = await createAccount(e, { sourceId: SOURCE, provider: "microsoft", services: [OUTLOOK_MAIL_SERVICE], principalRef: "admin:operator", accountLabel: UPN,
        config: { mailbox_address: OWNER } });
      await storeCredential(e, kek, account, { access_token: GRAPH_ACCESS_TOKEN, refresh_token: GRAPH_REFRESH_TOKEN }, {
        scopes: ["Mail.Read", "User.Read", "email", "offline_access", "openid"], expiresAt: new Date(T0 + 3_000_000),
      });
      await setAccountEnabled(e, account.id, true);

      const providers = new ProviderRegistry();
      providers.register(outlookTestProvider());
      const world = outlookWorld();
      // The newsletter asks a question too; bring it inside the sweep's window so it is judged.
      world.messages.find(m => m.id === "b1")!.receivedDateTime = new Date(T0 - 2 * 86_400_000).toISOString();
      const rt = connectorRuntime(db.storage, {
        kek, providers, fetch: outlookFetch(world), env: ENV, now: () => T0, sleep: async () => {},
        embedFn: async (t: string) => deterministicEmbed(t),
      });
      const loaded = (await rt.loadAccount(account.id))!;
      expect((await runConnectorSync(db.storage, loaded, rt.depsFor(loaded))).status).toBe("success");
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM loop_threads WHERE source_id = $1`, [SOURCE])).rows[0]!.n)).toBe(6);

      expect(await sweepLoops(e, SOURCE, new Date(T0))).toMatchObject({ threads: 6, opened: 2 });
      const loops = (await listLoops(e, [SOURCE])).map(l => [l.loop_type, l.counterparty]).sort();
      expect(loops).toEqual([
        ["unanswered_inbound", "Carol Diaz <carol@example.com>"],
        ["unanswered_outbound", "Eve Ng <eve@example.net>"],
      ]);
    } finally { await db.close(); }
  });
});
