import { describe, expect, it } from "bun:test";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`migration 144 (${name})`, () => {
    it("nulls deleted targets and restores the restrictive FK on rollback", async () => {
      const db = await open();
      const e = db.storage.engine();
      async function seed() {
        const a = await e.query<{ id: number }>("INSERT INTO entity_facts (entity_slug, fact) VALUES ('people/a','target') RETURNING id");
        const b = await e.query<{ id: number }>("INSERT INTO entity_facts (entity_slug, fact, superseded_by) VALUES ('people/a','history',$1) RETURNING id", [a.rows[0]!.id]);
        return { target: a.rows[0]!.id, history: b.rows[0]!.id };
      }
      try {
        const first = await seed();
        await e.query("DELETE FROM entity_facts WHERE id=$1", [first.target]);
        expect((await e.query("SELECT superseded_by FROM entity_facts WHERE id=$1", [first.history])).rows).toEqual([{ superseded_by: null }]);
        for (const id of discoverMigrations().map(m => m.id).filter(id => id > 144).sort((a,b) => b-a)) await revertMigration(e, id);
        await revertMigration(e, 144);
        const second = await seed();
        await expect(e.query("DELETE FROM entity_facts WHERE id=$1", [second.target])).rejects.toMatchObject({ code: "23503" });
        await runMigrations(e);
        await e.query("DELETE FROM entity_facts WHERE id=$1", [second.target]);
        expect((await e.query("SELECT superseded_by FROM entity_facts WHERE id=$1", [second.history])).rows).toEqual([{ superseded_by: null }]);
      } finally { await db.close(); }
    });
  });
}
