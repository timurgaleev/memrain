/**
 * An item that comes back under a new slug retires its old page through the
 * upstream deletion path before it settles, so a failed retirement leaves the
 * item unsettled and the next run tries again: the old page, which may hold
 * text the provider dropped, is never left live behind a settled item.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { runConnectorSync, type SyncAccount, type SyncAdapter, type SyncDeps, type UpstreamDeletion } from "../src/core/connectors/sync-engine.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { fakeClock } from "./github-recorded.ts";
import type { Storage } from "../src/core/storage.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const ACCOUNT_ID = "8f4b2e3c-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const SOURCE = "moves";

function adapter(slug: () => string, version: () => string): SyncAdapter {
  return {
    streams: () => ["s"],
    async page({ client }) {
      const res = await client.get("/v1/item");
      if (res.class !== "ok") return { ok: false, response: res };
      return { ok: true, items: [{ externalId: "t1", version: version(), slug: slug(), type: "connector-mail", title: "T", body: `Body at ${slug()}.\n` }], checkpoint: null, done: true };
    },
  };
}

function deps(a: SyncAdapter, onDelete: (item: UpstreamDeletion) => Promise<void>): SyncDeps {
  const clock = fakeClock();
  return {
    adapter: a,
    tokenSource: async () => ({ token: async () => "tok-value-2", refresh: async () => "tok-value-2" }),
    client: (_a, tokenSource) => new ConnectorClient({
      origin: ORIGIN, tokenSource, fetch: async () => Response.json({}), now: clock.now, sleep: clock.sleep, maxRetries: 0,
    }),
    accounts: { markNeedsReconnect: async () => {} },
    onUpstreamDelete: async (_s: Storage, item) => onDelete(item),
    embedFn: async (t: string) => deterministicEmbed(t),
    env: { MEMRAIN_CONNECTORS_ENABLED: "1" },
  };
}

const account: SyncAccount = { id: ACCOUNT_ID, sourceId: SOURCE, provider: "test", enabled: true, status: "active", itemCapDaily: 5000, spendCapUsdDaily: 1 };

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`moved item pages (${name})`, () => {
  it("retires the old page before settling, and tries again when retiring fails", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
      await e.query(`INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, $2, 'test', 'admin:operator', 'owner@example.test')`, [ACCOUNT_ID, SOURCE]);
      let slug = "mail/acct/2026-09/t1";
      let version = "1";
      const a = adapter(() => slug, () => version);
      const retired: string[] = [];
      await runConnectorSync(db.storage, account, deps(a, async () => {}));

      slug = "mail/acct/2026-11/t1";
      version = "2";
      const failing = await runConnectorSync(db.storage, account, deps(a, async () => { throw new OperationError("conflict", "busy"); }));
      expect(failing.counts.items_failed).toBe(1);
      const row = async () => (await e.query<{ page_slug: string }>(`SELECT page_slug FROM connector_items WHERE account_id = $1 AND external_id = 't1'`, [ACCOUNT_ID])).rows[0]!;
      // Not settled on the new slug: the next run still knows the old page.
      expect((await row()).page_slug).toBe("mail/acct/2026-09/t1");

      const ok = await runConnectorSync(db.storage, account, deps(a, async (item) => { retired.push(item.pageSlug ?? ""); }));
      expect(ok.counts.items_failed).toBe(0);
      expect(retired).toEqual(["mail/acct/2026-09/t1"]);
      expect((await row()).page_slug).toBe("mail/acct/2026-11/t1");
    } finally { await db.close(); }
  });
});
