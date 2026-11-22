import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { embeddingVectorType } from "../src/core/embedding-column.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const DIM = 1024;

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const columnType = async (e: Engine) => (await e.query<{ t: string }>(
  `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
    WHERE attrelid = 'embeddings'::regclass AND attname = 'vector' AND NOT attisdropped`)).rows[0]?.t;

const vectorIndexes = async (e: Engine) => (await e.query<{ name: string; opclass: string }>(
  `SELECT c.relname::text AS name, o.opcname::text AS opclass
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_opclass o ON o.oid = i.indclass[0]
    WHERE i.indrelid = 'embeddings'::regclass AND c.relname LIKE 'embeddings_vector%'
    ORDER BY 1`)).rows;

// Deterministic unit vectors: doc i sits at angle 0.12*(i+1) rad from the
// query's main axis, plus a small shared jitter, so cosine similarity falls
// off in clear steps (gaps ~0.02-0.1, far above halfvec rounding at ~1e-3).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) - 0.5;
}
function unit(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}
const DOCS = 6;
function docVector(i: number): number[] {
  const r = lcg(1000 + i);
  const v = Array.from({ length: DIM }, () => r() * 0.004);
  const theta = 0.12 * (i + 1);
  v[0] = (v[0] ?? 0) + Math.cos(theta);
  v[i + 1] = (v[i + 1] ?? 0) + Math.sin(theta);
  return unit(v);
}
const QUERY = (() => {
  const r = lcg(7);
  const v = Array.from({ length: DIM }, () => r() * 0.004);
  v[0] = (v[0] ?? 0) + 1;
  return unit(v);
})();

async function seed(e: Engine): Promise<void> {
  for (let i = 0; i < DOCS; i++) {
    await e.query(
      `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
       VALUES ($1, $2, $1, '{}'::jsonb, NOW())`, [`hv${i}`, `notes/hv${i}.md`]);
    await e.query(
      `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, 'x')`, [`hv${i}c0`, `hv${i}`]);
    await e.query(
      `INSERT INTO embeddings (chunk_id, vector, model) VALUES ($1, $2::vector, 'test')`,
      [`hv${i}c0`, JSON.stringify(docVector(i))]);
  }
}

const storedVector = async (e: Engine, chunkId: string) => JSON.parse((await e.query<{ v: string }>(
  `SELECT vector::text AS v FROM embeddings WHERE chunk_id = $1`, [chunkId])).rows[0]!.v) as number[];

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 191 (${name})`, () => {
  // Value: protects=chunk vectors convert to halfvec in place with the matching HNSW opclass, keep their
  // nearest-neighbour order, and the migration reverts, reapplies and repairs; fails_when=the column or index
  // keeps vector_cosine_ops, a leftover rebuild index survives, values drift past half precision, the ranking
  // changes, the cached cast goes stale across a migration, or the down file fails.
  it("converts embeddings.vector to halfvec, keeps the ranking, and reverts and reapplies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 191);
      expect(await columnType(e)).toBe(`vector(${DIM})`);
      expect(await vectorIndexes(e)).toEqual([{ name: "embeddings_vector_idx", opclass: "vector_cosine_ops" }]);
      expect(await embeddingVectorType(e)).toBe("vector");

      await seed(e);
      const before = await vectorSearch(e, QUERY, DOCS);
      expect(before).toEqual(Array.from({ length: DOCS }, (_, i) => `hv${i}c0`));
      // What an interrupted REINDEX CONCURRENTLY leaves behind.
      await e.exec(`CREATE INDEX embeddings_vector_idx_ccnew ON embeddings USING hnsw (vector vector_cosine_ops)`);

      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(191);
      expect(await columnType(e)).toBe(`halfvec(${DIM})`);
      expect(await vectorIndexes(e)).toEqual([{ name: "embeddings_vector_idx", opclass: "halfvec_cosine_ops" }]);
      expect(await embeddingVectorType(e)).toBe("halfvec");

      const after = await vectorSearch(e, QUERY, DOCS);
      expect(after).toEqual(before);
      const original = docVector(2);
      const stored = await storedVector(e, "hv2c0");
      expect(stored).toHaveLength(DIM);
      expect(Math.max(...stored.map((x, k) => Math.abs(x - original[k]!)))).toBeLessThan(1e-3);

      // A new write binds against the converted column.
      await e.query(`INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
                     VALUES ('hvq', 'notes/hvq.md', 'hvq', '{}'::jsonb, NOW())`);
      await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('hvqc0', 'hvq', 0, 'x')`);
      await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('hvqc0', $1::halfvec, 'test')`,
        [JSON.stringify(QUERY)]);
      expect((await vectorSearch(e, QUERY, 1))[0]).toBe("hvqc0");
      await e.query(`DELETE FROM documents WHERE id = 'hvq'`);

      // Re-run is a no-op; a converted column that lost its index gets it back.
      expect((await runMigrations(e)).applied).toEqual([]);
      await e.exec(`DROP INDEX embeddings_vector_idx`);
      await e.query(`DELETE FROM migrations WHERE id = 191`);
      expect((await runMigrations(e)).applied.map(m => m.id)).toEqual([191]);
      expect(await vectorIndexes(e)).toEqual([{ name: "embeddings_vector_idx", opclass: "halfvec_cosine_ops" }]);

      // A converted column with a sound index keeps it, and loses a rebuild's leftover.
      const mainOid = async () => (await e.query<{ oid: string }>(
        `SELECT 'embeddings_vector_idx'::regclass::oid::text AS oid`)).rows[0]!.oid;
      const oidBefore = await mainOid();
      await e.exec(`CREATE INDEX embeddings_vector_idx_rebuild_1 ON embeddings USING hnsw (vector halfvec_cosine_ops)`);
      await e.query(`DELETE FROM migrations WHERE id = 191`);
      expect((await runMigrations(e)).applied.map(m => m.id)).toEqual([191]);
      expect(await vectorIndexes(e)).toEqual([{ name: "embeddings_vector_idx", opclass: "halfvec_cosine_ops" }]);
      expect(await mainOid()).toBe(oidBefore);

      await revertDownTo(e, 191);
      expect(await columnType(e)).toBe(`vector(${DIM})`);
      expect(await vectorIndexes(e)).toEqual([{ name: "embeddings_vector_idx", opclass: "vector_cosine_ops" }]);
      expect(await embeddingVectorType(e)).toBe("vector");
      expect(await vectorSearch(e, QUERY, DOCS)).toEqual(before);

      await runMigrations(e);
      expect(await columnType(e)).toBe(`halfvec(${DIM})`);
      expect(await vectorSearch(e, QUERY, DOCS)).toEqual(before);
    } finally { await db.close(); }
  });
});
