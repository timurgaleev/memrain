import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const column = async (e: Engine, table: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = 'trust_tier'`, [table])).rows[0]!.n;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 158 (${name})`, () => {
  it("adds nullable trust_tier columns that only accept the vocabulary", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const t of ["pages", "entity_facts", "documents"]) expect(await column(e, t)).toBe(1);
      await e.query(`INSERT INTO documents (id, source_path, trust_tier) VALUES ('d-ok', 'a.md', 'member')`);
      await expect(e.query(`INSERT INTO documents (id, source_path, trust_tier) VALUES ('d-bad', 'b.md', 'trusted')`)).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("refuses to drop a tier only a document records, then reverts and reapplies cleanly", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 158);
      await e.query(`INSERT INTO documents (id, source_path, trust_tier) VALUES ('d-agent', 'agent/note.md', 'agent')`);
      await expect(revertMigration(e, 158)).rejects.toThrow("indexed inline by agents");
      expect(await column(e, "documents")).toBe(1);
      await e.exec(`UPDATE documents SET trust_tier = NULL`);
      await revertMigration(e, 158);
      for (const t of ["pages", "entity_facts", "documents"]) expect(await column(e, t)).toBe(0);
      const triggers = (await e.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('page_versions_trust_tier', 'entity_facts_trust_tier')`)).rows[0]!.n;
      expect(triggers).toBe(0);
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id).filter(id => id >= 158)[0]).toBe(158);
      for (const t of ["pages", "entity_facts", "documents"]) expect(await column(e, t)).toBe(1);
    } finally { await db.close(); }
  });
});
