/**
 * code-graph core (code_callers / code_callees MCP backing). Seeds two TS
 * files where beta() calls alpha(), then exercises the call-graph reads
 * directly against the engine. Offline (PGLite, no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import {
  codeCallers,
  codeCallees,
  parsePathLine,
} from "../src/core/code-graph.ts";

const dbDir = mkdtempSync(join(tmpdir(), "tb-code-graph-db-"));
const repoDir = mkdtempSync(join(tmpdir(), "tb-code-graph-repo-"));
let storage: Storage;
const betaPath = join(repoDir, "beta.ts");

beforeAll(async () => {
  const pgPath = join(dbDir, "brain.pglite");
  storage = new Storage({ dbPath: pgPath });
  await storage.init();
  writeFileSync(join(repoDir, "alpha.ts"), `export function alpha() { return 1; }\n`);
  writeFileSync(
    betaPath,
    `import { alpha } from "./alpha";\nexport function beta() { return alpha(); }\n`,
  );
  await indexCodeFile(storage, join(repoDir, "alpha.ts"));
  await indexCodeFile(storage, betaPath);
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("parsePathLine", () => {
  it("splits on the last colon", () => {
    expect(parsePathLine("src/x.ts:42")).toEqual({ file: "src/x.ts", line: 42 });
  });
  it("rejects missing/invalid line", () => {
    expect(parsePathLine("src/x.ts")).toBeNull();
    expect(parsePathLine("src/x.ts:0")).toBeNull();
    expect(parsePathLine(":5")).toBeNull();
  });
});

describe("codeCallers", () => {
  it("finds the caller of alpha (beta)", async () => {
    const r = await codeCallers(storage.engine(), "alpha");
    expect(r.query.type).toBe("code-caller");
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.mentions.some((m) => m.source_path === betaPath)).toBe(true);
    expect("readiness" in r).toBe(false);
  });
  it("returns empty for an unknown symbol", async () => {
    const r = await codeCallers(storage.engine(), "no_such_symbol_xyz");
    expect(r.count).toBe(0);
    expect(r.mentions).toEqual([]);
    expect(r.readiness?.state).toBe("ready");
  });
});

describe("codeCallees", () => {
  it("resolves the symbol at beta.ts:2 and lists its callees (alpha)", async () => {
    const r = await codeCallees(storage.engine(), `${betaPath}:2`);
    expect(r.resolved_symbol).toBe("beta");
    expect(r.mentions.some((m) => m.surface_form.includes("alpha"))).toBe(true);
  });
  it("reports resolved_symbol null when no symbol covers the line", async () => {
    const r = await codeCallees(storage.engine(), `${betaPath}:9999`);
    expect(r.resolved_symbol).toBeNull();
    expect(r.count).toBe(0);
  });
  it("throws on a malformed target", async () => {
    await expect(codeCallees(storage.engine(), "not a symbol")).rejects.toThrow();
    await expect(codeCallees(storage.engine(), "   ")).rejects.toThrow();
  });
});
