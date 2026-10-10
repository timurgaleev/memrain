/**
 * Code retrieval end to end over a small TS + Go + Python repo
 * (tests/fixtures/code-repo): index every file through the real indexer, run
 * the resolve-symbol-edges phase, then walk and read the graph through the
 * same functions the code_* MCP tools call. Offline (PGLite, no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { resolveSymbolEdgesPhase } from "../src/core/cycle/resolve-symbol-edges.ts";
import { classifySink, runRecursiveWalk, type WalkResult } from "../src/core/code-walk.ts";
import { codeCallees, codeDefs } from "../src/core/code-graph.ts";

setDefaultTimeout(30000);

const FIXTURE = join(import.meta.dir, "fixtures", "code-repo");
const dbDir = mkdtempSync(join(tmpdir(), "tb-code-fixture-db-"));
let storage: Storage;

function symbols(r: WalkResult): string[][] {
  if (r.result !== "ok") throw new Error(`expected ok, got ${r.result}`);
  return r.depth_groups.map((g) => g.nodes.map((n) => n.symbol).sort());
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
  for (const lang of ["ts", "go", "py"]) {
    for (const f of readdirSync(join(FIXTURE, lang)).sort()) {
      await indexCodeFile(storage, join(FIXTURE, lang, f));
    }
  }
  await resolveSymbolEdgesPhase(storage.engine());
  // A file removed from the repo is soft-deleted until the purge runs.
  await storage.engine().query(
    "UPDATE documents SET deleted_at = NOW() WHERE source_path = $1",
    [join(FIXTURE, "ts", "legacy.ts")],
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("code_blast over a qualified method", () => {
  it("finds the method caller through a member call, then its caller", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Repo::save", {
      direction: "callers",
      exact: true,
    });
    // `service.save()` in handleCreate is an unresolved call to bare `save`:
    // with no receiver type it may be Repo::save too, and a blast radius
    // over-reports rather than miss a caller.
    expect(symbols(r)).toEqual([["Service::save", "handleCreate"]]);
  });

  it("leaves out a caller whose file was deleted", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Repo::save", {
      direction: "callers",
      exact: true,
    });
    expect(symbols(r).flat()).not.toContain("legacyImport");
  });

  it("keeps an edge resolved to another definition out, and other languages out", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Worker::step", {
      direction: "callers",
      exact: true,
    });
    const found = symbols(r).flat();
    expect(found).toContain("Worker::run");
    expect(found).not.toContain("Other::go");
    expect(found).not.toContain("runSteps");
  });

  it("follows a Go package-qualified call", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Persist", { direction: "callers" });
    expect(symbols(r)).toEqual([["Handle"]]);
  });

  it("suggests near names when the symbol is unknown", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Persit", { direction: "callers" });
    expect(r.result).toBe("not_found");
    if (r.result !== "not_found") return;
    expect(r.did_you_mean.map((d) => d.symbol_qualified)).toContain("Persist");
  });
});

describe("code_flow", () => {
  it("walks a two-step method chain to the qualified definition", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Service::save", {
      direction: "callees",
      exact: true,
    });
    const groups = symbols(r);
    expect(groups[0]).toEqual(["Repo::save"]);
    expect(groups[1]).toContain("execute");
    if (r.result !== "ok") return;
    const node = r.depth_groups[0]!.nodes[0]!;
    expect(node.resolved).toBe(true);
    expect(node.def_chunk_id).toBeTruthy();
  });

  it("does not tag a map lookup as an http call", async () => {
    const r = await runRecursiveWalk(storage.engine(), "Service::lookup", {
      direction: "callees",
      exact: true,
    });
    expect(symbols(r).flat()).toContain("get");
    if (r.result !== "ok") return;
    expect(r.terminal_nodes ?? []).toEqual([]);
  });
});

describe("classifySink", () => {
  it("ignores bare container verbs and gates names by language", () => {
    for (const verb of ["get", "put", "read", "write", "open", "delete", "update", "query", "request"]) {
      expect(classifySink(verb, "typescript")).toBe("unknown");
    }
    expect(classifySink("fetch", "typescript")).toBe("http_call");
    expect(classifySink("ReadFile", "go")).toBe("file_io");
    expect(classifySink("ReadFile", "python")).toBe("unknown");
    expect(classifySink("readFileSync", "go")).toBe("unknown");
  });
});

describe("code mentions", () => {
  it("carry language, kind, line range and a snippet, and filter by language", async () => {
    const all = await codeDefs(storage.engine(), "step");
    expect(new Set(all.mentions.map((m) => m.language))).toEqual(new Set(["typescript", "python"]));
    const py = await codeDefs(storage.engine(), "step", undefined, undefined, "python");
    expect(py.count).toBe(2);
    const m = py.mentions[0]!;
    expect(m.language).toBe("python");
    expect(m.kind).toBe("function");
    expect(m.start_line).toBeGreaterThan(0);
    expect(m.end_line).toBeGreaterThanOrEqual(m.start_line!);
    expect(m.snippet).toContain("def step");
  });

  it("code_callees accepts a symbol name as well as path:line", async () => {
    const r = await codeCallees(storage.engine(), "Worker::run");
    expect(r.resolved_symbol).toBe("Worker::run");
    expect(r.mentions.map((m) => m.surface_form.split("@")[0])).toEqual(["step"]);
  });
});
