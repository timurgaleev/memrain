import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const hasTable = async (e: Engine) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'code_prunes'`)).rows[0]!.n === 1;

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const record = (e: Engine, restoredBy: string | null) => e.query(
  `INSERT INTO code_prunes (sweep_id, trigger, document_id, source_path, root, pruned_at, restored_at, restored_by)
   VALUES ('cp-x', 'sweep', 'doc_x', '/r/x.ts', '/r', now(), CASE WHEN $1::text IS NULL THEN NULL ELSE now() END, $1)`,
  [restoredBy]);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 190 (${name})`, () => {
  // Value: protects=the prune provenance table applies on a live brain, rejects a half-restored row, reverts
  // and reapplies; fails_when=the table or a check is missing, or the down file fails.
  it("adds code_prunes, and reverts and reapplies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 190);
      expect(await hasTable(e)).toBe(false);

      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(190);
      await record(e, null);
      await record(e, "cli");
      await expect(e.query(
        `INSERT INTO code_prunes (sweep_id, trigger, document_id, source_path, root, pruned_at, restored_by)
         VALUES ('cp-x', 'sweep', 'doc_y', '/r/y.ts', '/r', now(), 'cli')`)).rejects.toThrow();
      await expect(e.query(
        `INSERT INTO code_prunes (sweep_id, trigger, document_id, source_path, root, pruned_at)
         VALUES ('cp-x', 'cron', 'doc_y', '/r/y.ts', '/r', now())`)).rejects.toThrow();

      // The record outlives its source and follows a rename.
      await e.query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('mig190-src', 'code', '/mig190/')`);
      await e.query(
        `INSERT INTO code_prunes (sweep_id, trigger, document_id, source_id, source_path, root, pruned_at)
         VALUES ('cp-y', 'sweep', 'doc_z', 'mig190-src', '/mig190/z.ts', '/mig190', now())`);
      await e.query(`UPDATE sources SET id = 'mig190-renamed' WHERE id = 'mig190-src'`);
      const src = async () => (await e.query<{ source_id: string | null }>(
        `SELECT source_id FROM code_prunes WHERE document_id = 'doc_z'`)).rows[0]?.source_id;
      expect(await src()).toBe("mig190-renamed");
      await e.query(`DELETE FROM sources WHERE id = 'mig190-renamed'`);
      expect(await src()).toBeNull();

      await revertDownTo(e, 190);
      expect(await hasTable(e)).toBe(false);
      await runMigrations(e);
      expect(await hasTable(e)).toBe(true);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });
});
