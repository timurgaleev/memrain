import { afterAll, beforeAll, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { evalRun, runConfigHash, type Qrels } from "../src/commands/eval.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[0]["open"]>>;
beforeAll(async () => {
  db = await storageEngines(undefined)[0]!.open();
  await writeDocumentTransaction(db.storage,
    { documentId: "via-doc", sourcePath: "/private-via.md", title: "quartz protocol", embeddingModel: "test", frontmatter: {} },
    [{ text: "quartz protocol uses versioned envelopes", entities: [], embedding: null }]);
});
afterAll(async () => { await db.close(); });

it("scores the real operator MCP search/query results and fingerprints the surface", async () => {
  const qrels: Qrels = { queries: [{ id: "q", query: "quartz protocol", expected_paths: ["/private-via.md"] }] };
  const hashes: string[] = [];
  for (const via of ["search", "query"] as const) {
    const report = await evalRun(db.storage, qrels, { expansion: false, rerank: false }, { via, k: 5 });
    expect(report.via).toBe(via);
    expect(report.errors).toEqual([]);
    const actual = await dispatchTool(db.storage, { name: via, arguments: { q: "quartz protocol", k: 15 } });
    const payload = JSON.parse(actual.content[0]!.text);
    expect(actual.isError).not.toBe(true);
    expect(report.perQuery[0]!.topPaths).toEqual([...new Set<string>(payload.hits.map((h: { sourcePath: string }) => h.sourcePath))].slice(0, 5));
    expect(report.meanRecall).toBe(1);
    hashes.push(report.run_config_hash);
  }
  expect(new Set(hashes).size).toBe(2);
  expect(hashes).not.toContain(runConfigHash({ expansion: false, rerank: false }, 5, "q"));
});

it("refuses unrepresentable MCP ranking knobs instead of silently ignoring them", async () => {
  await expect(evalRun(db.storage, { queries: [] }, { rrfK: 10 }, { via: "query" })).rejects.toThrow(/rrfK/);
});
