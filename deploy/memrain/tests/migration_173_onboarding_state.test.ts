/**
 * Migration 173 (the /app onboarding state). The number is a placeholder:
 * hosting migrations are renumbered when their lane merges, and this file
 * with them.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60_000);

const ID = 173;
const table = async (e: Engine, t: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration ${ID} (${name})`, () => {
  it("keeps one row per member, a known step, and goes with its member", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(`INSERT INTO members (id) VALUES ('alice')`);
      await e.query(`INSERT INTO onboarding_state (member_id) VALUES ('alice')`);
      const row = await e.query<{ step: string }>(`SELECT step FROM onboarding_state WHERE member_id = 'alice'`);
      expect(row.rows[0]!.step).toBe("connect");
      await expect(e.query(`INSERT INTO onboarding_state (member_id) VALUES ('alice')`)).rejects.toThrow();
      await expect(e.query(`UPDATE onboarding_state SET step = 'later' WHERE member_id = 'alice'`)).rejects.toThrow();
      await expect(e.query(`INSERT INTO onboarding_state (member_id) VALUES ('nobody')`)).rejects.toThrow();
      await e.query(`DELETE FROM members WHERE id = 'alice'`);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM onboarding_state`)).rows[0]!.n).toBe(0);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("reverts only as the latest migration, then applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, ID);
      await revertMigration(e, ID);
      expect(await table(e, "onboarding_state")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(ID);
      expect(await table(e, "onboarding_state")).toBe(true);
    } finally { await db.close(); }
  });
});
