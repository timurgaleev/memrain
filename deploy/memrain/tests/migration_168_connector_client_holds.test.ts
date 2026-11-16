import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, t: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`, [t])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const HOLD = `INSERT INTO connector_client_holds (provider, client_id, reason, service_code, held_until) VALUES ($1, 'app-1', $2, $3, NOW())`;
const NOTIFY = `INSERT INTO notifications (source_id, kind, ref) VALUES ('default', $1, 'microsoft')`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 168 (${name})`, () => {
  it("records one refused OAuth app per provider, by code only, and lets the owner be told about it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(HOLD, ["microsoft", "invalid_client", 7000222]);
      await e.query(HOLD, ["google", "unauthorized_client", null]);
      await expect(e.query(HOLD, ["microsoft", "invalid_client", null])).rejects.toThrow();
      await expect(e.query(HOLD, ["other", "the secret expired", null])).rejects.toThrow();
      await expect(e.query(HOLD, ["Bad/Provider", "invalid_client", null])).rejects.toThrow();
      await e.query(NOTIFY, ["oauth_client_rejected"]);
      await expect(e.query(NOTIFY, ["something_else"])).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 168);
      await e.query(NOTIFY, ["oauth_client_rejected"]);
      await revertMigration(e, 168);
      expect(await table(e, "connector_client_holds")).toBe(false);
      await expect(e.query(NOTIFY, ["oauth_client_rejected"])).rejects.toThrow();
      await e.query(NOTIFY, ["needs_reconnect"]);
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(168);
      expect(await table(e, "connector_client_holds")).toBe(true);
    } finally { await db.close(); }
  });
});
