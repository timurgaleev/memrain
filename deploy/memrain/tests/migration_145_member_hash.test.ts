import { describe, expect, it } from "bun:test";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`migration 145 (${name})`, () => {
    it("drops only the hash cache on rollback and reapplies without losing the concept", async () => {
      const db = await open();
      const e = db.storage.engine();
      const columns = () => e.query("SELECT column_name FROM information_schema.columns WHERE table_name='synth_concepts' AND column_name='member_hash'");
      try {
        expect((await columns()).rows).toHaveLength(1);
        await e.query("INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id, member_hash) VALUES ('alpha','Alpha','keep','T3',2,'deterministic','hash')");
        for (const id of discoverMigrations().map(m => m.id).filter(id => id > 145).sort((a,b) => b-a)) await revertMigration(e, id);
        await revertMigration(e, 145);
        expect((await columns()).rows).toHaveLength(0);
        await runMigrations(e);
        expect((await columns()).rows).toHaveLength(1);
        expect((await e.query("SELECT narrative, member_hash FROM synth_concepts WHERE concept_slug='alpha'")).rows).toEqual([{ narrative: "keep", member_hash: null }]);
      } finally { await db.close(); }
    });
  });
}
