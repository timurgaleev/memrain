/**
 * doctor's `code-graph` probe (core/doctor-ops.ts): a code index that reports
 * `ready` can still be hollow — documents with no definitions, chunks with no
 * language (which every language-filtered read skips), or a resolve-phase
 * backlog that never drains. PGLite, offline.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";
import { checkCodeGraph } from "../src/core/doctor-ops.ts";

setDefaultTimeout(25000);

const tmp = mkdtempSync(join(tmpdir(), "memrain-doctor-code-graph-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("checkCodeGraph", () => {
  it("is ok with no code indexed", async () => {
    const r = await checkCodeGraph(storage.raw());
    expect(r.status).toBe("ok");
  });

  it("is ok for a resolved, fully labelled index", async () => {
    await indexCodeDocument(storage, {
      sourcePath: "/cg/a.ts",
      text: "export function a() { return b(); }\nexport function b() { return 1; }\n",
    });
    await resolveSymbolEdgesPhase(storage.raw());
    const r = await checkCodeGraph(storage.raw());
    expect(r.status).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("warns on code chunks with no language", async () => {
    await storage.raw().query(
      "UPDATE chunks SET language = NULL WHERE document_id = (SELECT id FROM documents WHERE source_path = '/cg/a.ts')",
    );
    try {
      const r = await checkCodeGraph(storage.raw());
      expect(r.status).toBe("warn");
      expect(r.ok).toBe(true);
      expect(r.detail).toContain("no language");
    } finally {
      await storage.raw().query(
        "UPDATE chunks SET language = 'typescript' WHERE document_id = (SELECT id FROM documents WHERE source_path = '/cg/a.ts')",
      );
    }
  });

  it("warns when the resolve phase leaves edges waiting past the threshold", async () => {
    await indexCodeDocument(storage, {
      sourcePath: "/cg/c.ts",
      text: "export function c() { return d(); }\n",
    });
    await storage.raw().query(
      "UPDATE code_edges_symbol SET created_at = NOW() - interval '3 days'",
    );
    const r = await checkCodeGraph(storage.raw());
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("awaiting resolution");
    await resolveSymbolEdgesPhase(storage.raw());
    expect((await checkCodeGraph(storage.raw())).status).toBe("ok");
  });

  it("warns when most code documents carry no definition", async () => {
    for (const n of [1, 2, 3]) {
      await indexCodeDocument(storage, { sourcePath: `/cg/barrel${n}.ts`, text: `export * from "./m${n}";\n` });
    }
    const r = await checkCodeGraph(storage.raw(), { minDocsForRatio: 2 });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("without a definition");
  });
});
