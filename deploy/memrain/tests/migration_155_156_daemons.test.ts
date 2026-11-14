import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

/** Only the latest migration can be reverted, so later ones go first. */
async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 155 and 156 (${name})`, () => {
  it("create the daemon controls and provider lease tables", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await table(e, "daemon_controls")).toBe("daemon_controls");
      expect(await table(e, "provider_leases")).toBe("provider_leases");
      await e.query(`INSERT INTO daemon_controls (daemon) VALUES ('cycle')`);
      const row = (await e.query<{ source_id: string; paused: boolean; consecutive_failures: number }>(
        `SELECT source_id, paused, consecutive_failures FROM daemon_controls WHERE daemon = 'cycle'`)).rows[0]!;
      expect(row).toEqual({ source_id: "*", paused: false, consecutive_failures: 0 });
      await expect(e.query(`INSERT INTO daemon_controls (daemon, consecutive_failures) VALUES ('x', -1)`)).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("each down refuses while it would lose operator state, then up again restores both", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 156);
      await e.query(`INSERT INTO provider_leases (id, lease_key, owner, expires_at) VALUES ('l1', 'bedrock:haiku', 'h:1', NOW() + INTERVAL '1 hour')`);
      await expect(revertMigration(e, 156)).rejects.toThrow("live");
      await e.exec(`DELETE FROM provider_leases`);
      await revertMigration(e, 156);
      expect(await table(e, "provider_leases")).toBeNull();

      await e.query(`INSERT INTO daemon_controls (daemon, paused, paused_by) VALUES ('*', true, 'operator')`);
      await expect(revertMigration(e, 155)).rejects.toThrow("operator");
      expect(await table(e, "daemon_controls")).toBe("daemon_controls");
      await e.exec(`UPDATE daemon_controls SET paused = false, paused_by = NULL`);
      await revertMigration(e, 155);
      expect(await table(e, "daemon_controls")).toBeNull();

      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id).filter(id => id >= 155)).toEqual([155, 156]);
      expect(await table(e, "daemon_controls")).toBe("daemon_controls");
    } finally { await db.close(); }
  });
});
