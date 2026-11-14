import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

const columns = async (e: Engine, tableName: string) => (await e.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`, [tableName],
)).rows.map(r => r.column_name);

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 157 (${name})`, () => {
  it("adds the wallet attribution columns and the paused-path table", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const log = await columns(e, "mcp_spend_log");
      for (const c of ["role", "daemon", "daemon_source", "overrun_cents"]) expect(log).toContain(c);
      const holds = await columns(e, "mcp_spend_reservations");
      for (const c of ["role", "daemon", "daemon_source"]) expect(holds).toContain(c);
      expect(await table(e, "spend_path_pauses")).toBe("spend_path_pauses");
      await expect(e.query(
        `INSERT INTO mcp_spend_log (operation, spend_cents, overrun_cents) VALUES ('x', 1, -1)`,
      )).rejects.toThrow();
      await e.query(`INSERT INTO spend_path_pauses (path, reason) VALUES ('connector_sync', 'overrun')`);
      // One open pause per path; a resolved one does not block a new one.
      await expect(e.query(`INSERT INTO spend_path_pauses (path, reason) VALUES ('connector_sync', 'overrun')`)).rejects.toThrow();
      await e.query(`UPDATE spend_path_pauses SET resolved_at = NOW()`);
      await e.query(`INSERT INTO spend_path_pauses (path, reason) VALUES ('connector_sync', 'overrun')`);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("down refuses while a path is paused, keeps every ledger row, and up again restores it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 157);
      await e.query(`INSERT INTO mcp_spend_log (operation, spend_cents, role) VALUES ('x', 5, 'facts-extract')`);
      await e.query(`INSERT INTO spend_path_pauses (path, reason) VALUES ('facts-extract', 'overrun')`);
      await expect(revertMigration(e, 157)).rejects.toThrow("paused");
      await e.exec(`UPDATE spend_path_pauses SET resolved_at = NOW()`);
      await revertMigration(e, 157);
      expect(await table(e, "spend_path_pauses")).toBeNull();
      expect(await columns(e, "mcp_spend_log")).not.toContain("role");
      expect((await e.query(`SELECT 1 FROM mcp_spend_log WHERE operation = 'x'`)).rows).toHaveLength(1);
      const again = await runMigrations(e);
      // The later migrations reverted above come back with it.
      expect(again.applied.map(m => m.id).filter(id => id >= 157))
        .toEqual(discoverMigrations().map(m => m.id).filter(id => id >= 157).sort((a, b) => a - b));
      expect(await table(e, "spend_path_pauses")).toBe("spend_path_pauses");
    } finally { await db.close(); }
  });
});
