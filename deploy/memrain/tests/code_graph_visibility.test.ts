/**
 * Code graph reads that answer from chunk text or walk the edge table: what a
 * mention may carry, which documents it may come from, how a document's edges
 * are written, and how a walk spends its row and node budget. Offline (PGLite).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { codeCallees, codeCallers, codeDefs, codeRefs } from "../src/core/code-graph.ts";
import { runRecursiveWalk, type WalkResult } from "../src/core/code-walk.ts";

setDefaultTimeout(30000);

const dbDir = mkdtempSync(join(tmpdir(), "tb-code-graph-vis-"));
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

function symbols(r: WalkResult): string[] {
  if (r.result !== "ok") throw new Error(`expected ok, got ${r.result}`);
  return r.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
}

describe("code mentions", () => {
  it("leave out archived and quarantined documents", async () => {
    const e = storage.engine();
    const archived = await indexCodeDocument(storage, {
      sourcePath: "/vis/archived.ts",
      text: "export function hiddenArchived() { return 1; }\n",
      mtimeMs: 1,
    });
    const held = await indexCodeDocument(storage, {
      sourcePath: "/vis/held.ts",
      text: "export function hiddenHeld() { return 1; }\n",
      mtimeMs: 1,
    });
    expect((await codeDefs(e, "hiddenArchived")).count).toBe(1);
    expect((await codeDefs(e, "hiddenHeld")).count).toBe(1);

    await e.query("UPDATE documents SET archived = true WHERE id = $1", [archived.documentId]);
    await e.query(
      `UPDATE documents SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"patterns": ["x"]}}'::jsonb
        WHERE id = $1`,
      [held.documentId],
    );
    expect((await codeDefs(e, "hiddenArchived")).count).toBe(0);
    expect((await codeDefs(e, "hiddenHeld")).count).toBe(0);
  });

  it("carry no chunk text unless the caller asks for a snippet", async () => {
    const e = storage.engine();
    await indexCodeDocument(storage, {
      sourcePath: "/vis/snip.ts",
      text: "export function snipCallee() { return 1; }\nexport function snipCaller() { return snipCallee(); }\n",
      mtimeMs: 1,
    });
    const plain = [
      await codeDefs(e, "snipCallee"),
      await codeCallers(e, "snipCallee"),
      await codeCallees(e, "snipCaller"),
    ];
    for (const r of plain) {
      expect(r.count).toBeGreaterThan(0);
      for (const m of r.mentions) expect("snippet" in m).toBe(false);
    }
    expect((await codeRefs(e, "snipCallee")).mentions.every((m) => !("snippet" in m))).toBe(true);

    const def = await codeDefs(e, "snipCallee", undefined, undefined, undefined, { snippet: true });
    expect(def.mentions[0]!.snippet).toContain("function snipCallee");
    const callees = await codeCallees(e, "snipCaller", undefined, undefined, undefined, { snippet: true });
    expect(callees.mentions[0]!.snippet).toContain("snipCaller");
  });
});

describe("code edge writes", () => {
  it("write a document's edges in one statement, duplicates included", async () => {
    const e = storage.engine();
    await e.exec(`
      CREATE TABLE test_edge_stmts (n INTEGER);
      CREATE OR REPLACE FUNCTION test_count_edge_stmt() RETURNS trigger AS $$
      BEGIN INSERT INTO test_edge_stmts VALUES (1); RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_count_edge_stmt AFTER INSERT ON code_edges_symbol
        FOR EACH STATEMENT EXECUTE FUNCTION test_count_edge_stmt();`);
    try {
      const doc = await indexCodeDocument(storage, {
        sourcePath: "/vis/batch.ts",
        text:
          "export function top() { one(); two(); two(); return three(); }\n" +
          "export function one() { return 1; }\n",
        mtimeMs: 1,
      });
      const stmts = await e.query<{ n: number }>("SELECT count(*)::int AS n FROM test_edge_stmts");
      expect(stmts.rows[0]!.n).toBe(1);
      const edges = await e.query<{ from_symbol_qualified: string; to_symbol_qualified: string }>(
        `SELECT from_symbol_qualified, to_symbol_qualified FROM code_edges_symbol e
           JOIN chunks c ON c.id = e.from_chunk_id
          WHERE c.document_id = $1
          ORDER BY to_symbol_qualified`,
        [doc.documentId],
      );
      expect(edges.rows.map((r) => `${r.from_symbol_qualified}>${r.to_symbol_qualified}`)).toEqual([
        "top>one",
        "top>three",
        "top>two",
      ]);
    } finally {
      await e.exec(`
        DROP TRIGGER IF EXISTS test_count_edge_stmt ON code_edges_symbol;
        DROP TABLE IF EXISTS test_edge_stmts;`);
    }
  });
});

/** A chunk row on `docId` for seeding the graph without parsing source. */
async function seedChunk(docId: string, id: string, index: number, symbol: string | null): Promise<void> {
  await storage.engine().query(
    `INSERT INTO chunks (id, document_id, chunk_index, content, symbol_name, symbol_name_qualified, language)
     VALUES ($1, $2, $3, $4, $5, $6, 'typescript')`,
    [id, docId, index, `function ${symbol ?? "x"}() {}`, symbol?.split("::").pop() ?? null, symbol],
  );
}

describe("code walks", () => {
  it("call a name ambiguous when a crowded hop cuts its second definition", async () => {
    const e = storage.engine();
    const caller = await indexCodeDocument(storage, {
      sourcePath: "/vis/crowd.ts",
      text: "export function crowdCaller() { crowdCommon(); return crowdTwin(); }\n",
      mtimeMs: 1,
    });
    // 4999 definitions of one name sort ahead of the two of another; a single
    // row cap over both names keeps just one crowdTwin.
    await e.query(
      `INSERT INTO chunks (id, document_id, chunk_index, content, symbol_name, symbol_name_qualified, language)
       SELECT 'aa_' || lpad(n::text, 5, '0'), $1, 1000 + n, 'function crowdCommon() {}',
              'crowdCommon', 'M' || n || '::crowdCommon', 'typescript'
         FROM generate_series(1, 4999) AS n`,
      [caller.documentId],
    );
    await seedChunk(caller.documentId, "zz_twin_1", 9001, "A::crowdTwin");
    await seedChunk(caller.documentId, "zz_twin_2", 9002, "B::crowdTwin");

    const r = await runRecursiveWalk(e, "crowdCaller", { direction: "callees", exact: true, depth: 1 });
    if (r.result !== "ok") throw new Error(r.result);
    const twin = r.depth_groups[0]!.nodes.find((n) => n.symbol.endsWith("crowdTwin"))!;
    expect(twin).toEqual(expect.objectContaining({ symbol: "crowdTwin", resolved: false }));
  });

  it("rank callers of the exact name ahead of bare-name guesses", async () => {
    const e = storage.engine();
    const host = await indexCodeDocument(storage, {
      sourcePath: "/vis/get.ts",
      text: "export function getHost() { return 1; }\n",
      mtimeMs: 1,
    });
    await seedChunk(host.documentId, "zz_def_get", 2000, "Repo::get");
    for (let i = 1; i <= 5; i++) {
      await seedChunk(host.documentId, `ga_${i}`, 2000 + i, `bareGetter${i}`);
      await e.query(
        `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type)
         VALUES ($1, $2, 'get', 'calls')`,
        [`ga_${i}`, `bareGetter${i}`],
      );
    }
    await seedChunk(host.documentId, "zz_exact", 2010, "exactGetter");
    await e.query(
      `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type)
       VALUES ('zz_exact', 'exactGetter', 'Repo::get', 'calls')`,
    );

    const r = await runRecursiveWalk(e, "Repo::get", { direction: "callers", maxNodes: 2, depth: 1 });
    expect(symbols(r)[0]).toBe("exactGetter");
  });
});
