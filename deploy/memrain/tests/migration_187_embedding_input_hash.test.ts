import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { embeddingVectorType } from "../src/core/embedding-column.ts";
import { deterministicEmbed } from "./det-embed.ts";

const hasColumn = async (e: Engine, table: string, col: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, col])).rows[0]!.n === 1;

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 187 (${name})`, () => {
  // Value: protects=deploying 187 keeps every stored vector and stamps none, so nothing re-embeds;
  // fails_when=the migration backfills a hash, drops rows, or does not revert cleanly.
  it("adds a nullable hash without touching stored vectors, and reverts and reapplies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 187);
      expect(await hasColumn(e, "embeddings", "input_hash")).toBe(false);
      // A vector written before the column existed (the current writer names it, so by hand).
      await e.query(`INSERT INTO documents (id, source_path, title, frontmatter) VALUES ('legacy', 'notes/legacy', 'Legacy', '{}'::jsonb)`);
      await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('legacy_c0', 'legacy', 0, 'legacy vector')`);
      await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('legacy_c0', $1::vector, 'm')`,
        [JSON.stringify(deterministicEmbed("legacy vector"))]);
      const before = (await e.query<{ vec: string }>(`SELECT vector::text AS vec FROM embeddings WHERE chunk_id = 'legacy_c0'`)).rows[0]!.vec;

      expect((await runMigrations(e)).applied.map(m => m.id)[0]).toBe(187);
      expect(await hasColumn(e, "embeddings", "input_hash")).toBe(true);
      const row = (await e.query<{ vec: string; input_hash: string | null }>(
        `SELECT vector::text AS vec, input_hash FROM embeddings WHERE chunk_id = 'legacy_c0'`)).rows[0]!;
      // runMigrations also applies the later ones, and 191 stores the column at
      // half precision: the vector must be the same one at the column's precision.
      const type = await embeddingVectorType(e);
      const expected = (await e.query<{ v: string }>(`SELECT $1::text::${type}::text AS v`, [before])).rows[0]!.v;
      expect(row.vec).toBe(expected);
      expect(row.input_hash).toBeNull();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });
});
