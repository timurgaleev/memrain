import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";
import { runRecursiveWalk, type WalkResult } from "../src/core/code-walk.ts";
import { registerSource } from "../src/core/sources.ts";

function nodes(result: WalkResult) {
  if (result.result !== "ok") throw new Error(`Expected ok, got ${result.result}`);
  return result.depth_groups.flatMap(g => g.nodes);
}

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`code definition identity ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
    for (const suffix of ["A", "B"]) await indexCodeDocument(db.storage, { sourcePath: `/walk/${suffix}.ts`, sourceId: "default",
      text: `function helper() { sink${suffix}(); }\nfunction start${suffix}() { helper(); }\nfunction root${suffix}() { start${suffix}(); }` });
    await indexCodeDocument(db.storage, { sourcePath: "/walk/unknown.ts", sourceId: "default",
      text: "function unbound() { helper(); }\nfunction both() { startA(); startB(); }" });
    await indexCodeDocument(db.storage, { sourcePath: "/other/hidden.ts", sourceId: "other",
      text: "function helper() { secretSink(); }\nfunction hidden() { helper(); }" });
    await resolveSymbolEdgesPhase(db.storage.engine());
  });
  afterAll(async () => { await db.close(); });
  it("distinguishes definitions at the start and accepts the returned path:symbol", async () => {
    for (const exact of [false, true]) {
      const r = await runRecursiveWalk(db.storage.engine(), "helper", { direction: "callers", sourceIds: ["default"], exact });
      expect(r.result).toBe("ambiguous");
      if (r.result !== "ambiguous") throw new Error(r.result);
      expect(r.candidates.map(c => c.symbol_qualified)).toEqual(["/walk/A.ts:helper", "/walk/B.ts:helper"]);
    }
    const r = nodes(await runRecursiveWalk(db.storage.engine(), "/walk/A.ts:helper", { direction: "callers", sourceIds: ["default"] }));
    expect(r.filter(n => n.resolved).map(n => n.symbol).sort()).toEqual(["rootA", "startA"]);
    expect(r.find(n => n.symbol === "unbound")?.resolved).toBe(false);
    expect(r.some(n => n.symbol.endsWith("B"))).toBe(false);
    expect((await runRecursiveWalk(db.storage.engine(), "/other/hidden.ts:helper", { direction: "callers", sourceIds: ["default"] })).result).toBe("not_found");
  });
  it("carries the definition chunk through every hop instead of merging equal names", async () => {
    const r = nodes(await runRecursiveWalk(db.storage.engine(), "rootA", { direction: "callees", sourceIds: ["default"] }));
    expect(r.map(n => n.symbol)).toEqual(["startA", "helper", "sinkA"]);
    expect(r.find(n => n.symbol === "helper")!.def_chunk_id).toBeTruthy();
    const both = nodes(await runRecursiveWalk(db.storage.engine(), "both", { direction: "callees", sourceIds: ["default"] }));
    expect(both.filter(n => n.symbol === "helper")).toHaveLength(2);
    expect(new Set(both.filter(n => n.symbol === "helper").map(n => n.def_chunk_id)).size).toBe(2);
    expect(both.map(n => n.symbol)).toContain("sinkA");
    expect(both.map(n => n.symbol)).toContain("sinkB");
    expect(both.map(n => n.symbol)).not.toContain("secretSink");
  });
  it("leaves ambiguous unresolved callees as candidates without traversing both definitions", async () => {
    const r = nodes(await runRecursiveWalk(db.storage.engine(), "unbound", { direction: "callees", sourceIds: ["default"] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: "helper", resolved: false });
    expect(r[0]!.def_chunk_id).toBeUndefined();
  });
  it("never follows a resolved target outside the visible source scope", async () => {
    await indexCodeDocument(db.storage, { sourcePath: "/walk/scope.ts", sourceId: "default", text: "function scopeEntry() { helper(); }" });
    await db.storage.engine().query(`UPDATE code_edges_symbol SET edge_metadata = jsonb_build_object('resolved_chunk_id',
      (SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_path = '/other/hidden.ts' AND c.symbol_name = 'helper'))
      WHERE from_symbol_qualified = 'scopeEntry'`);
    expect(nodes(await runRecursiveWalk(db.storage.engine(), "scopeEntry", { direction: "callees", sourceIds: ["default"] }))).toEqual([]);
  });
});
