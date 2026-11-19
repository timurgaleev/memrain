import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const column = async (e: Engine, t: string, c: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const CLIENT = `INSERT INTO connector_oauth_clients (provider, client_id, kek_id, nonce, ciphertext, tenant) VALUES ($1, 'cid', 'k1', 'n', 'c', $2)`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 167 (${name})`, () => {
  it("adds an optional tenant to a stored OAuth client that cannot hold a path", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await column(e, "connector_oauth_clients", "tenant")).toBe(true);
      await e.query(CLIENT, ["microsoft", "organizations"]);
      await e.query(CLIENT, ["other", null]);
      await expect(e.query(CLIENT, ["third", "common/../x"])).rejects.toThrow();
      await expect(e.query(CLIENT, ["fourth", "Common"])).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 167);
      await revertMigration(e, 167);
      expect(await column(e, "connector_oauth_clients", "tenant")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(167);
      expect(await column(e, "connector_oauth_clients", "tenant")).toBe(true);
    } finally { await db.close(); }
  });
});
