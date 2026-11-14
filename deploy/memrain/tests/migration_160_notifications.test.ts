import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const ROW = `INSERT INTO notifications (source_id, kind, ref) VALUES ($1, $2, $3)`;
const count = async (e: Engine) => (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications`)).rows[0]!.n;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 160 (${name})`, () => {
  it("creates the notification table with its constraints", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await table(e, "notifications")).toBe("notifications");
      await e.query(ROW, ["default", "needs_reconnect", "acct-1"]);
      // One open notification per problem.
      await expect(e.query(ROW, ["default", "needs_reconnect", "acct-1"])).rejects.toThrow();
      // A resolved one does not block the next episode of the same problem.
      await e.query(`UPDATE notifications SET resolved_at = NOW()`);
      await e.query(ROW, ["default", "needs_reconnect", "acct-1"]);
      // Unknown kinds, an empty ref and a free-text error are refused.
      await expect(e.query(ROW, ["default", "page_text", "x"])).rejects.toThrow();
      await expect(e.query(ROW, ["default", "items_held", ""])).rejects.toThrow();
      await expect(e.query(`UPDATE notifications SET webhook_error = 'HTTP 500: secret body'`)).rejects.toThrow();
      await expect(e.query(`UPDATE notifications SET webhook_state = 'sent'`)).rejects.toThrow();
      await expect(e.query(`UPDATE notifications SET webhook_attempts = -1`)).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("goes with its source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
      await e.query(ROW, ["acme", "write_gate_hold", "acme"]);
      await e.query(`DELETE FROM sources WHERE id = 'acme'`);
      expect(await count(e)).toBe(0);
    } finally { await db.close(); }
  });

  it("down drops the table and up restores it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 160);
      await e.query(ROW, ["default", "items_held", "acct-2"]);
      await revertMigration(e, 160);
      expect(await table(e, "notifications")).toBeNull();
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toContain(160);
      expect(await table(e, "notifications")).toBe("notifications");
    } finally { await db.close(); }
  });
});
