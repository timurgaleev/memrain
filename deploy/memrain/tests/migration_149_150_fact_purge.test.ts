import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

// The CHECK exactly as migration 097 left it, in the server's own rendering.
const CHECK_097 = "CHECK (((forgotten_cause IS NULL) OR (forgotten_cause = ANY (ARRAY['forget'::text, 'supersede'::text, 'consolidate'::text]))))";

const causeCheck = async (e: Engine) => (await e.query<{ def: string }>(
  `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'entity_facts_forgotten_cause_chk' AND conrelid = 'entity_facts'::regclass`)).rows[0]?.def;
const receiptsTable = async (e: Engine) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass('fact_purge_receipts')::text AS t`)).rows[0]!.t;
const purgeTombstone = (e: Engine) => e.query<{ id: number }>(
  `INSERT INTO entity_facts (entity_slug, fact, forgotten_at, forgotten_cause) VALUES ('people/x', 'Purged.', NOW(), 'purge') RETURNING id`);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 149 and 150 (${name})`, () => {
  it("are consecutive, so their downs run in turn once later ones are reverted", () => {
    expect(discoverMigrations().map((m) => m.id).filter((id) => id >= 149 && id <= 150)).toEqual([149, 150]);
  });

  it("admit the purge cause and keep receipts; each down refuses while it would lose them", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 150).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);
      const fact = Number((await purgeTombstone(e)).rows[0]!.id);
      await e.query(`INSERT INTO fact_purge_receipts (purge_id, page_slug, source_id, fact_ids) VALUES ($1, 'people/x', 'default', ARRAY[$2]::bigint[])`,
        [crypto.randomUUID(), fact]);

      await expect(revertMigration(e, 150)).rejects.toThrow("receipts");
      expect(await receiptsTable(e)).toBe("fact_purge_receipts");
      await e.exec(`DELETE FROM fact_purge_receipts`);
      await revertMigration(e, 150);
      expect(await receiptsTable(e)).toBeNull();

      await expect(revertMigration(e, 149)).rejects.toThrow("purge");
      expect(await causeCheck(e)).toContain("purge");
      await e.query(`UPDATE entity_facts SET forgotten_cause = 'forget' WHERE id = $1`, [fact]);
      await revertMigration(e, 149);
      expect(await causeCheck(e)).toBe(CHECK_097);
      await expect(purgeTombstone(e)).rejects.toThrow();

      const again = await runMigrations(e);
      expect(again.applied.map((m) => m.id)).toEqual([149, 150, ...later.reverse()]);
      expect(await causeCheck(e)).toContain("purge");
      expect(await receiptsTable(e)).toBe("fact_purge_receipts");
      await purgeTombstone(e);
    } finally { await db.close(); }
  });
});
