/**
 * Migration 172 (member web sign-in). The number is a placeholder: hosting
 * migrations are renumbered when their lane merges, and this file with them.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60_000);

const ID = 172;
const table = async (e: Engine, t: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration ${ID} (${name})`, () => {
  it("hangs every row off its member and audits self-service as via app", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(`INSERT INTO members (id) VALUES ('alice')`);
      await e.query(`INSERT INTO member_web_sessions (id_hash, member_id, via, expires_at) VALUES ('h1', 'alice', 'passkey', now() + interval '1 day')`);
      await expect(e.query(`INSERT INTO member_web_sessions (id_hash, member_id, via, expires_at) VALUES ('h2', 'alice', 'cookie', now())`)).rejects.toThrow();
      await expect(e.query(`INSERT INTO member_web_sessions (id_hash, member_id, via, expires_at) VALUES ('h3', 'nobody', 'passkey', now())`)).rejects.toThrow();
      await e.query(`INSERT INTO member_audit (member_id, action, actor, via) VALUES ('alice', 'bind', 'member:alice', 'app')`);
      await expect(e.query(`INSERT INTO member_audit (member_id, action, actor, via) VALUES ('alice', 'bind', 'x', 'web')`)).rejects.toThrow();
      await e.query(`DELETE FROM member_audit`);
      await e.query(`DELETE FROM members WHERE id = 'alice'`);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM member_web_sessions`)).rows[0]!.n).toBe(0);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("refuses to revert over member passkeys, then reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, ID);
      await e.query(`INSERT INTO members (id) VALUES ('alice')`);
      await e.query(`INSERT INTO member_passkeys (id, member_id, user_handle, public_key, device_type, label) VALUES ('c1', 'alice', 'h', 'pk', 'multiDevice', 'Laptop')`);
      await expect(revertMigration(e, ID)).rejects.toThrow(/member passkeys exist/);
      await e.query(`DELETE FROM member_passkeys`);
      await revertMigration(e, ID);
      for (const t of ["member_passkeys", "member_invites", "member_web_sessions"]) expect(await table(e, t)).toBe(false);
      await expect(e.query(`INSERT INTO member_audit (member_id, action, actor, via) VALUES ('alice', 'bind', 'x', 'app')`)).rejects.toThrow();
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(ID);
      expect(await table(e, "member_web_sessions")).toBe(true);
    } finally { await db.close(); }
  });
});
