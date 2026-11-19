import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

async function seedAccount(e: Engine, sourceId: string): Promise<string> {
  const id = crypto.randomUUID();
  await e.query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label)
     VALUES ($1, $2, 'test', 'admin:operator', 'someone@example.test')`, [id, sourceId]);
  await e.query(
    `INSERT INTO connector_credentials (account_id, kek_id, nonce, ciphertext, scopes)
     VALUES ($1, 'k', 'n', 'c', ARRAY['read'])`, [id]);
  return id;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 152 and 154 (${name})`, () => {
  it("create the connector account, credential, client and oauth-state tables", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const t of ["connector_accounts", "connector_credentials", "connector_oauth_clients", "connector_oauth_states"]) {
        expect(await table(e, t)).toBe(t);
      }
    } finally { await db.close(); }
  });

  it("refuse to delete a source that still has a connector account", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await seedAccount(e, "inbox");
      await expect(e.query(`DELETE FROM sources WHERE id = 'inbox'`)).rejects.toThrow();
    } finally { await db.close(); }
  });

  it("deleting an account removes its credential and leaves pages alone", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await putPage(db.storage, { slug: "mail/kept", markdown_body: "stays", source_id: "inbox" });
      const id = await seedAccount(e, "inbox");
      await e.query(`DELETE FROM connector_accounts WHERE id = $1`, [id]);
      expect((await e.query(`SELECT 1 FROM connector_credentials WHERE account_id = $1`, [id])).rows).toEqual([]);
      expect((await e.query(`SELECT 1 FROM pages WHERE slug = 'mail/kept'`)).rows.length).toBe(1);
    } finally { await db.close(); }
  });

  it("reject an unknown account status", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const id = await seedAccount(e, "inbox");
      await e.query(`UPDATE connector_accounts SET status = 'needs_reconnect' WHERE id = $1`, [id]);
      await expect(e.query(`UPDATE connector_accounts SET status = 'reauth_required' WHERE id = $1`, [id])).rejects.toThrow();
    } finally { await db.close(); }
  });

  it("each down refuses while it would lose rows, then reverts and re-applies cleanly", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 154).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);

      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      await e.query(
        `INSERT INTO connector_oauth_states
           (state_hash, provider, source_id, principal_ref, admin_session_hash, kek_id, nonce,
            pkce_verifier_enc, requested_scopes, redirect_uri, expires_at)
         VALUES ('h', 'test', 'inbox', 'admin:operator', 's', 'k', 'n', 'c', ARRAY['read'],
                 'https://brain.example.test/cb', NOW() + interval '10 minutes')`);
      await expect(revertMigration(e, 154)).rejects.toThrow("pending");
      expect(await table(e, "connector_oauth_states")).toBe("connector_oauth_states");
      await e.exec(`UPDATE connector_oauth_states SET consumed_at = NOW()`);
      await revertMigration(e, 154);
      expect(await table(e, "connector_oauth_states")).toBeNull();

      const between = discoverMigrations().map((m) => m.id).filter((id) => id > 152 && id < 154).sort((a, b) => b - a);
      for (const id of between) await revertMigration(e, id);

      const id = await seedAccount(e, "inbox");
      await expect(revertMigration(e, 152)).rejects.toThrow("connector accounts");
      expect(await table(e, "connector_accounts")).toBe("connector_accounts");
      await e.query(`DELETE FROM connector_accounts WHERE id = $1`, [id]);
      await e.query(`INSERT INTO connector_oauth_clients (provider, client_id, kek_id, nonce, ciphertext) VALUES ('test', 'cid', 'k', 'n', 'c')`);
      await expect(revertMigration(e, 152)).rejects.toThrow("oauth clients");
      await e.exec(`DELETE FROM connector_oauth_clients`);
      await revertMigration(e, 152);
      for (const t of ["connector_accounts", "connector_credentials", "connector_oauth_clients"]) {
        expect(await table(e, t)).toBeNull();
      }

      const again = await runMigrations(e);
      expect(again.applied.map((m) => m.id)).toEqual([152, ...between.reverse(), 154, ...later.reverse()]);
      expect(await table(e, "connector_accounts")).toBe("connector_accounts");
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });
});
