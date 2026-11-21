import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const hasTable = async (e: Engine, table: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`, [table])).rows[0]!.n === 1;

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const skip = (e: Engine) => e.query(
  `INSERT INTO synth_failures (doc_id, phase, content_hash, model, kind, next_eligible_at)
   VALUES ('page://notes/a', 'reflections', 'h', 'm', 'skipped', 'infinity')`);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 188-189 (${name})`, () => {
  // Value: protects=both migrations apply on a live brain, revert cleanly and reapply;
  // fails_when=the skipped kind is not accepted, the down leaves rows the old check rejects, or a down fails.
  it("adds the rejection table and the skipped kind, and reverts and reapplies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 188);
      expect(await hasTable(e, "entity_dedupe_rejections")).toBe(false);
      await expect(skip(e)).rejects.toThrow();

      const applied = (await runMigrations(e)).applied.map(m => m.id);
      expect(applied.slice(0, 2)).toEqual([188, 189]);
      await skip(e);
      await e.query(`INSERT INTO entity_dedupe_rejections (source_id, a_slug, b_slug, decided_by) VALUES ('default', 'people/a', 'people/b', 'operator')`);
      await expect(e.query(`INSERT INTO entity_dedupe_rejections (source_id, a_slug, b_slug, decided_by) VALUES ('default', 'people/a', 'people/a', 'operator')`)).rejects.toThrow();

      await revertDownTo(e, 188);
      expect(await hasTable(e, "entity_dedupe_rejections")).toBe(false);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_failures WHERE phase = 'reflections'`)).rows[0]!.n).toBe(0);
      await runMigrations(e);
      expect(await hasTable(e, "entity_dedupe_rejections")).toBe(true);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });
});
