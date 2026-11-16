/**
 * Connector text is always written under the redact disposition, whatever
 * MEMRAIN_SECRET_SCAN_DISPOSITION says: a mail carrying a one-time login link
 * or a pasted token is stored with the credential cut out, instead of being
 * refused whole (`reject`, which would hold the thread forever) or stored as
 * it came (`flag`). Writes outside a connector run keep the operator's choice.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { runConnectorSync, type SyncAccount, type SyncAdapter, type SyncDeps } from "../src/core/connectors/sync-engine.ts";
import { fingerprintSecret, secretDisposition, SecretRejectedError } from "../src/core/secret-scan.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { fakeClock, LEAKED_TOKEN, replay } from "./github-recorded.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const ACCOUNT_ID = "7e3a1d2b-4c5f-4a6b-9c7d-8e9f0a1b2c3d";
const SOURCE = "mail-test";
const SLUG = "mail/acct/thread-1";
const MARKER = `[REDACTED:github-token:${fingerprintSecret(LEAKED_TOKEN)}]`;

const adapter: SyncAdapter = {
  streams: () => ["mail"],
  async page({ client }) {
    const res = await client.get("/v1/thread");
    if (res.class !== "ok") return { ok: false, response: res };
    const body = `Your sign-in token is ${LEAKED_TOKEN} and expires soon.\n`;
    return {
      ok: true,
      items: [{ externalId: "t1", version: "1", slug: SLUG, type: "connector-mail", title: "Sign in", body, truth: { origin: "connector", trust: "untrusted" } }],
      checkpoint: "c1",
      done: true,
    };
  },
};

function deps(): SyncDeps {
  const clock = fakeClock();
  const fake = replay([{ status: 200, headers: { "content-type": "application/json" }, body: {} }]);
  return {
    adapter,
    tokenSource: async () => ({ token: async () => "tok-value-1", refresh: async () => "tok-value-1" }),
    client: (_a, tokenSource) => new ConnectorClient({ origin: ORIGIN, tokenSource, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxRetries: 0 }),
    accounts: { markNeedsReconnect: async () => {} },
    embedFn: async (t: string) => deterministicEmbed(t),
    env: { MEMRAIN_CONNECTORS_ENABLED: "1" },
  };
}

const account: SyncAccount = {
  id: ACCOUNT_ID, sourceId: SOURCE, provider: "test", enabled: true, status: "active", itemCapDaily: 5000, spendCapUsdDaily: 1,
};

async function setup(storage: Storage): Promise<void> {
  await registerSource(storage.engine(), { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
  await storage.engine().query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, $2, 'test', 'admin:operator', 'owner@example.test')`,
    [ACCOUNT_ID, SOURCE],
  );
}

const saved = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
afterEach(() => {
  if (saved === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = saved;
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector secret disposition (${name})`, () => {
  for (const disposition of ["reject", "flag"] as const) {
    it(`redacts a credential in connector text under ${disposition}, and leaves the setting alone after the run`, async () => {
      const db = await open();
      try {
        await setup(db.storage);
        process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = disposition;
        const result = await runConnectorSync(db.storage, account, deps());
        expect(result.status).toBe("success");
        expect(result.counts.items_failed).toBe(0);
        const row = (await db.storage.engine().query<{ markdown_body: string }>(
          `SELECT markdown_body FROM pages WHERE slug = $1 AND source_id = $2`, [SLUG, SOURCE])).rows[0]!;
        expect(row.markdown_body).not.toContain(LEAKED_TOKEN);
        expect(row.markdown_body).toContain(MARKER);
        expect(row.markdown_body).toContain("expires soon");
        // The override is the run's alone.
        expect(secretDisposition()).toBe(disposition);
      } finally { await db.close(); }
    });
  }

  it("keeps the operator's reject for a write outside a connector run", async () => {
    const db = await open();
    try {
      await registerSource(db.storage.engine(), { id: "notes", kind: "other", pathPrefix: "notes/" });
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
      const err = await putPage(db.storage, { slug: "notes/n1", source_id: "notes", markdown_body: `token ${LEAKED_TOKEN}` }).catch(e => e);
      expect(err).toBeInstanceOf(SecretRejectedError);
    } finally { await db.close(); }
  });
});
