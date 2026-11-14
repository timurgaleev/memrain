import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const ACCOUNT = "4f1c2a8e-6b0d-4c55-9a77-0d3e5f6a7b81";
const TABLES = ["connector_cursors", "connector_items", "connector_notices"] as const;

/** Only the latest migration can be reverted, so later ones go first. */
async function revertLaterThan153(e: Engine): Promise<void> {
  for (const id of discoverMigrations().map(m => m.id).filter(id => id > 153).sort((a, b) => b - a)) await revertMigration(e, id);
}

const present = async (e: Engine) => (await e.query<{ t: string | null }>(
  `SELECT unnest(ARRAY[to_regclass('connector_cursors')::text, to_regclass('connector_items')::text,
                       to_regclass('connector_notices')::text]) AS t`)).rows.map(r => r.t);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 153 (${name})`, () => {
  it("creates the cursor, item and notice tables with one open notice per account and kind", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await present(e)).toEqual([...TABLES]);
      await e.query(`INSERT INTO connector_cursors (account_id, stream, cursor) VALUES ($1, 'gmail.history', '42')`, [ACCOUNT]);
      await expect(e.query(`INSERT INTO connector_cursors (account_id, stream, cursor) VALUES ($1, 'gmail.history', '43')`, [ACCOUNT]))
        .rejects.toThrow();
      await e.query(`INSERT INTO connector_items (account_id, external_id, page_slug) VALUES ($1, 'm1', 'mail/a/m1')`, [ACCOUNT]);
      const item = (await e.query<{ fail_count: number; held_reason: string | null }>(
        `SELECT fail_count, held_reason FROM connector_items WHERE account_id = $1`, [ACCOUNT])).rows[0]!;
      expect({ fail_count: Number(item.fail_count), held_reason: item.held_reason }).toEqual({ fail_count: 0, held_reason: null });

      await e.query(`INSERT INTO connector_notices (account_id, kind, detail) VALUES ($1, 'needs_reconnect', 'x')`, [ACCOUNT]);
      await expect(e.query(`INSERT INTO connector_notices (account_id, kind, detail) VALUES ($1, 'needs_reconnect', 'y')`, [ACCOUNT]))
        .rejects.toThrow();
      await e.query(`UPDATE connector_notices SET resolved_at = NOW()`);
      await e.query(`INSERT INTO connector_notices (account_id, kind, detail) VALUES ($1, 'needs_reconnect', 'z')`, [ACCOUNT]);
      await expect(e.query(`INSERT INTO connector_notices (account_id, kind, detail) VALUES ($1, 'bogus', 'z')`, [ACCOUNT]))
        .rejects.toThrow();
    } finally { await db.close(); }
  });

  it("refuses a down that would lose sync state, then reverts and re-applies cleanly", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan153(e);
      await e.query(`INSERT INTO connector_items (account_id, external_id) VALUES ($1, 'm1')`, [ACCOUNT]);
      await expect(revertMigration(e, 153)).rejects.toThrow("sync state");
      expect(await present(e)).toEqual([...TABLES]);
      await e.exec(`DELETE FROM connector_items`);
      await revertMigration(e, 153);
      expect(await present(e)).toEqual([null, null, null]);
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toContain(153);
      expect(await present(e)).toEqual([...TABLES]);
    } finally { await db.close(); }
  });
});
