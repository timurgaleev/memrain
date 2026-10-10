/**
 * A code document's call edges are written in the same transaction as its
 * chunks: when the edge insert fails, the document keeps its previous chunks,
 * edges and mtime, so the next sweep re-indexes it instead of skipping a file
 * whose call graph never landed. Offline (PGLite).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

setDefaultTimeout(25000);

const dbDir = mkdtempSync(join(tmpdir(), "tb-code-edges-tx-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
  _resetParsersForTests();
});

async function failEdgeInserts(on: boolean): Promise<void> {
  const e = storage.engine();
  if (on) {
    await e.exec(`
      CREATE OR REPLACE FUNCTION test_fail_edge() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'edge insert failed'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_edge BEFORE INSERT ON code_edges_symbol
        FOR EACH ROW EXECUTE FUNCTION test_fail_edge();`);
  } else {
    await e.exec("DROP TRIGGER IF EXISTS test_fail_edge ON code_edges_symbol;");
  }
}

describe("code edges share the document transaction", () => {
  it("keeps the previous chunks, edges and mtime when the edge write fails", async () => {
    const v1 = "export function a() { return b(); }\nexport function b() { return 1; }\n";
    const first = await indexCodeDocument(storage, { sourcePath: "/tx/x.ts", text: v1, mtimeMs: 1000 });
    const e = storage.engine();
    const edgesBefore = await e.query<{ to_symbol_qualified: string }>(
      `SELECT to_symbol_qualified FROM code_edges_symbol e JOIN chunks c ON c.id = e.from_chunk_id
        WHERE c.document_id = $1`,
      [first.documentId],
    );
    expect(edgesBefore.rows.map((r) => r.to_symbol_qualified)).toEqual(["b"]);

    await failEdgeInserts(true);
    try {
      const v2 = "export function a() { return c(); }\nexport function c() { return 2; }\n";
      await expect(
        indexCodeDocument(storage, { sourcePath: "/tx/x.ts", text: v2, mtimeMs: 2000 }),
      ).rejects.toThrow(/edge insert failed/);
    } finally {
      await failEdgeInserts(false);
    }

    const doc = await e.query<{ last_indexed_mtime: string | number | null }>(
      "SELECT last_indexed_mtime FROM documents WHERE id = $1",
      [first.documentId],
    );
    expect(Number(doc.rows[0]?.last_indexed_mtime)).toBe(1000);
    const syms = await e.query<{ symbol_name: string }>(
      "SELECT symbol_name FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
      [first.documentId],
    );
    expect(syms.rows.map((r) => r.symbol_name)).toEqual(["a", "b"]);
    const edgesAfter = await e.query<{ to_symbol_qualified: string }>(
      `SELECT to_symbol_qualified FROM code_edges_symbol e JOIN chunks c ON c.id = e.from_chunk_id
        WHERE c.document_id = $1`,
      [first.documentId],
    );
    expect(edgesAfter.rows.map((r) => r.to_symbol_qualified)).toEqual(["b"]);
  });

  it("writes no document at all for a new file whose edges fail", async () => {
    await failEdgeInserts(true);
    try {
      await expect(
        indexCodeDocument(storage, {
          sourcePath: "/tx/y.ts",
          text: "export function y() { return z(); }\n",
          mtimeMs: 3000,
        }),
      ).rejects.toThrow(/edge insert failed/);
    } finally {
      await failEdgeInserts(false);
    }
    const doc = await storage.engine().query(
      "SELECT 1 FROM documents WHERE source_path = $1",
      ["/tx/y.ts"],
    );
    expect(doc.rows).toEqual([]);
  });
});
