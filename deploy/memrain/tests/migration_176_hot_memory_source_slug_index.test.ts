/**
 * Migration 176 — hot_memory.source_slug index: a page purge finds the page's
 * observations through it instead of scanning the table; up, down and up again.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

async function hasIndex(e: Engine): Promise<boolean> {
  const r = await e.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'hot_memory' AND indexname = 'hot_memory_source_slug_idx'`,
  );
  return r.rows.length === 1 && r.rows[0]!.indexdef.includes("(source_slug)");
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 176 (${name})`, () => {
  // Value: protects=a purge looks up hot_memory by source_slug without a full scan;
  // fails_when=the index is dropped or no longer matches the purge predicate; why_new=no test covered it; seam=none
  it("the purge lookup reads the index rather than every row", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(
        `INSERT INTO hot_memory (entity_slug, fact, source_slug)
         SELECT 'people/p' || g, 'fact ' || g, 'notes/n' || g FROM generate_series(1, 5000) g`,
      );
      await e.query(`ANALYZE hot_memory`);
      const plan = await e.transaction(async (tx) => {
        // The PGLite engine turns sequential scans off for its vector indexes;
        // turn them back on so the planner has the scan to prefer.
        await tx.query(`SET LOCAL enable_seqscan = on`);
        const r = await tx.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT id FROM hot_memory WHERE source_slug = ANY($1::text[])`,
          [["notes/n42"]],
        );
        return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("hot_memory_source_slug_idx");
    } finally { await db.close(); }
  });

  it("creates the index, reverts, and re-applies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await hasIndex(e)).toBe(true);
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 176).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);
      await revertMigration(e, 176);
      expect(await hasIndex(e)).toBe(false);
      const again = await runMigrations(e);
      expect(again.applied.map((m) => m.id)).toEqual([176, ...later.reverse()]);
      expect(await hasIndex(e)).toBe(true);
    } finally { await db.close(); }
  });
});
