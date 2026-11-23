import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const column = async (e: Engine, t: string, c: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const STATE = `INSERT INTO connector_oauth_states
  (state_hash, provider, source_id, principal_ref, admin_session_hash, kek_id, nonce, pkce_verifier_enc, requested_scopes, redirect_uri, expires_at, account_id)
  VALUES ($1, 'microsoft', 'inbox', 'admin:operator', 's', 'k', 'n', 'v', '{}', 'https://brain.example.test/cb', NOW(), $2)`;
const states = async (e: Engine) => (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM connector_oauth_states`)).rows[0]!.n;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 169 (${name})`, () => {
  it("names the account a reconnect is for, only an existing one, and drops the state with the account", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "inbox/" });
      // A connector account as an earlier build stored it.
      const account = (await e.query<{ id: string }>(
        `INSERT INTO connector_accounts (id, source_id, provider, services, principal_ref, account_label)
         VALUES ('00000000-0000-4000-8000-00000a000169', 'inbox', 'microsoft', ARRAY['outlook_mail'], 'admin:operator', 'me@example.test') RETURNING id::text AS id`,
      )).rows[0]!;
      await e.query(STATE, ["first-connect", null]);
      await e.query(STATE, ["reconnect", account.id]);
      await expect(e.query(STATE, ["gone", "0f0f0f0f-0000-4000-8000-00000000abcd"])).rejects.toThrow();
      await e.query(`DELETE FROM connector_accounts WHERE id = $1`, [account.id]);
      expect(await states(e)).toBe(1);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 169);
      await revertMigration(e, 169);
      expect(await column(e, "connector_oauth_states", "account_id")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(169);
      expect(await column(e, "connector_oauth_states", "account_id")).toBe(true);
    } finally { await db.close(); }
  });
});
