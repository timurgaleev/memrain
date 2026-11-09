import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { chunkCode, CODE_CHUNKER_VERSION } from "../src/core/chunkers/code.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { runRecursiveWalk } from "../src/core/code-walk.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { countStaleChunkerDocs } from "../src/core/chunker-version.ts";
import { deterministicEmbed } from "./det-embed.ts";

const source = 'import { it, describe } from "test";\nfunction helper() { innerOnly(); }\ndescribe("suite", () => { it("works", () => helper()); });\napp.use(handler);';
it("keeps module calls outside named definitions with original line locations", async () => {
  const parsed = await chunkCode(source, "/src/spec.ts", "typescript");
  const module = parsed.symbols.find(s => (s.kind as string) === "module");
  expect(module).toBeDefined();
  expect(module!.name).toBe("__module__");
  expect(module!.parentSymbolPath).toEqual(["spec.ts"]);
  expect(module!.body).not.toContain("innerOnly");
  expect(module!.body.split("\n")[2]).toContain("describe");
  expect((await chunkCode("function f() { hidden(); } f();", "same.ts", "typescript")).symbols.find(s => (s.kind as string) === "module")!.body).toContain("f();");
  const py = await chunkCode("def work():\n    hidden()\nwork()\n", "main.py", "python");
  expect(py.symbols.find(s => (s.kind as string) === "module")!.body).not.toContain("hidden");
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`module graph ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("indexes module calls and imports without vectors, including later backfill", async () => {
    const doc = await indexCodeDocument(db.storage, { sourcePath: "/src/spec.ts", text: source, sourceId: "default" });
    const edges = (await db.storage.engine().query<{ target: string }>(`SELECT to_symbol_qualified AS target FROM code_edges_symbol
      WHERE from_symbol_qualified = 'spec.ts::__module__' ORDER BY target`)).rows;
    expect(edges.map(r => r.target)).toEqual(["describe", "helper", "it", "use"]);
    await resolveSymbolEdgesPhase(db.storage.engine());
    const walk = await runRecursiveWalk(db.storage.engine(), "spec.ts::__module__", { direction: "callees" });
    expect(walk.result).toBe("ok");
    if (walk.result !== "ok") throw new Error(walk.result);
    expect(walk.depth_groups[0]!.nodes.map(n => n.symbol)).toContain("helper");
    expect((await db.storage.engine().query(`SELECT 1 FROM entity_mentions em JOIN chunks c ON c.id = em.chunk_id
      WHERE c.document_id = $1 AND c.symbol_type = 'module' AND em.surface_form LIKE '%:<import>'`, [doc.documentId])).rows.length).toBeGreaterThan(0);
    let calls = 0;
    await runEmbedBackfill(db.storage.engine(), { embed: async text => { calls++; return deterministicEmbed(text); } });
    expect(calls).toBe(0);
    expect(doc.embeddings).toBe(0);
    expect(CODE_CHUNKER_VERSION).toBe(4);
    await db.storage.engine().query(`UPDATE documents SET chunker_version = 3 WHERE id = $1`, [doc.documentId]);
    expect(await countStaleChunkerDocs(db.storage.engine())).toBe(1);
  });
  it("does not add module vectors when the same code is inside a markdown fence", async () => {
    const inputs: string[] = [];
    const doc = await indexDocument(db.storage, { sourcePath: "/module-example.md", text: "# Example\n\n```ts\napp.use(handler);\n```" },
      { embedFn: async text => { inputs.push(text); return deterministicEmbed(text); }, inferFrontmatter: false });
    expect(inputs).toHaveLength(1);
    expect((await db.storage.engine().query(`SELECT symbol_type FROM chunks WHERE document_id = $1 AND symbol_type = 'module'`, [doc.documentId])).rows).toEqual([]);
  });
});
