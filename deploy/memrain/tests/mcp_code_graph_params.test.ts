/**
 * The code graph MCP tools: `lang` reaches the engine, `code_callees` takes a
 * symbol name, and a mention carries chunk text only for a caller allowed
 * unredacted bodies (never on the public ingress).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";

setDefaultTimeout(30000);

let tmp: string;
let storage: Storage;

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const call = async (name: string, args: Record<string, unknown>, isPublic = false) =>
  payload(await dispatchTool(storage, { name, arguments: args }, isPublic ? { isPublic: true } : {}));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-code-params-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await indexCodeDocument(storage, {
    sourcePath: "/mcp-code/a.ts",
    text: "export function mcpTarget() { return 1; }\nexport function mcpEntry() { return mcpTarget(); }\n",
    mtimeMs: 1,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("code graph tool params", () => {
  it("an operator gets snippets; the public ingress never does", async () => {
    for (const [tool, args] of [
      ["code_def", { name: "mcpTarget" }],
      ["code_callers", { name: "mcpTarget" }],
      ["code_callees", { target: "mcpEntry" }],
    ] as const) {
      const operator = await call(tool, args);
      expect(operator.count).toBeGreaterThan(0);
      expect(operator.mentions.every((m: { snippet?: string }) => typeof m.snippet === "string")).toBe(true);
      const pub = await call(tool, args, true);
      expect(pub.count).toBe(operator.count);
      expect(pub.mentions.some((m: object) => "snippet" in m)).toBe(false);
    }
  });

  it("lang narrows the mentions", async () => {
    expect((await call("code_def", { name: "mcpTarget", lang: "typescript" })).count).toBe(1);
    expect((await call("code_def", { name: "mcpTarget", lang: "python" })).count).toBe(0);
    expect((await call("code_refs", { name: "mcpTarget", lang: "python" })).count).toBe(0);
    expect((await call("code_callers", { name: "mcpTarget", lang: "python" })).count).toBe(0);
    expect((await call("code_callees", { target: "mcpEntry", lang: "python" })).count).toBe(0);
  });

  it("code_callees resolves a symbol name", async () => {
    const out = await call("code_callees", { target: "mcpEntry" });
    expect(out.resolved_symbol).toBe("mcpEntry");
    expect(out.count).toBe(1);
    expect(out.mentions[0].surface_form).toStartWith("mcpTarget");
  });

  it("lang pins the walk", async () => {
    const ts = await call("code_flow", { symbol: "mcpEntry", lang: "typescript" });
    expect(ts.result).toBe("ok");
    expect(ts.depth_groups.flatMap((g: { nodes: { symbol: string }[] }) => g.nodes.map((n) => n.symbol))).toContain(
      "mcpTarget",
    );
    const py = await call("code_flow", { symbol: "mcpEntry", lang: "python" });
    expect(py.result).toBe("not_found");
  });
});
