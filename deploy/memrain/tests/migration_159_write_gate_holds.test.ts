import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

async function seedDocument(e: Engine): Promise<void> {
  await e.query(`INSERT INTO documents (id, source_id, source_path, title, frontmatter) VALUES ('doc_1', 'default', 'mail://1', 't', '{}'::jsonb)`);
}

const HOLD = `INSERT INTO write_gate_holds (source_id, document_id, target_ref, origin, reason_families, detector_version, binding, excerpt)
  VALUES ('default', 'doc_1', 'mail://1', 'external', ARRAY['ai_directive'], 'write-gate/v1', $1, 'excerpt')`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 159 (${name})`, () => {
  it("creates the hold table with its constraints", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await table(e, "write_gate_holds")).toBe("write_gate_holds");
      await seedDocument(e);
      await e.query(HOLD, ["a".repeat(64)]);
      // One hold per document and content binding.
      await expect(e.query(HOLD, ["a".repeat(64)])).rejects.toThrow();
      // A decision needs its timestamp and actor; an excerpt is capped.
      await expect(e.query(`UPDATE write_gate_holds SET decision = 'approved'`)).rejects.toThrow();
      await expect(e.query(`UPDATE write_gate_holds SET excerpt = repeat('x', 201)`)).rejects.toThrow();
      await expect(e.query(`UPDATE write_gate_holds SET origin = 'operator'`)).rejects.toThrow();
      // Removing the document removes its holds.
      await e.query(`DELETE FROM documents WHERE id = 'doc_1'`);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM write_gate_holds`)).rows[0]!.n).toBe(0);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("down refuses while a hold awaits a decision, then up again restores it", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 159);
      await seedDocument(e);
      await e.query(HOLD, ["b".repeat(64)]);
      await expect(revertMigration(e, 159)).rejects.toThrow("awaiting");
      await e.query(`UPDATE write_gate_holds SET decision = 'rejected', decided_at = NOW(), decided_by = 'operator'`);
      await revertMigration(e, 159);
      expect(await table(e, "write_gate_holds")).toBeNull();
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toContain(159);
      expect(await table(e, "write_gate_holds")).toBe("write_gate_holds");
    } finally { await db.close(); }
  });
});
