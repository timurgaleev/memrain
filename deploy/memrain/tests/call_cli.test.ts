/**
 * `memrain call` — invoke an MCP tool from the shell. Runs against a fresh
 * PGLite + a temp config (no Bedrock, no live brain). Exercises a read tool
 * (`stats`), argument validation, and the error exit code.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTORS } from "../src/core/advisor/run.ts";
import { runCall } from "../src/commands/call.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-call-test-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

describe("memrain call", () => {
  it("invokes a read tool (stats) and prints its JSON result", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runCall({ tool: "stats", configPath: cfgPath });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const out = cap.lines.join("\n");
    const parsed = JSON.parse(out) as { documents: number; chunks: number };
    expect(parsed.documents).toBe(0);
    expect(parsed.chunks).toBe(0);
  });

  it("passes --args JSON through to the tool", async () => {
    const cap = capture();
    try {
      await runCall({ tool: "stats", argsJson: "{}", configPath: cfgPath });
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).toContain("documents");
  });

  it("rejects malformed --args JSON", async () => {
    await expect(
      runCall({ tool: "stats", argsJson: "{not json", configPath: cfgPath }),
    ).rejects.toThrow(/valid JSON/);
  });

  it("rejects non-object --args", async () => {
    await expect(
      runCall({ tool: "stats", argsJson: "[1,2,3]", configPath: cfgPath }),
    ).rejects.toThrow(/JSON object/);
  });

  it("returns exit code 1 when the tool errors (unknown tool)", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runCall({ tool: "no_such_tool", configPath: cfgPath });
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
  });
});


it("reports a failed advisor collector safely and exits nonzero with partial findings", async () => {
  const collector = COLLECTORS[0]!;
  const broken = spyOn(collector, "collect").mockRejectedValue(new Error("PRIVATE failure payload"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  const cap = capture();
  try {
    const code = await runCall({ tool: "advisor", configPath: cfgPath });
    expect(code).toBe(1);
    const out = cap.lines.join("\n");
    const report = JSON.parse(out);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f: { id: string }) => f.id === `collector_failed:${collector.id}`)).toBe(true);
    expect(out).not.toContain("PRIVATE");
    expect(log).toHaveBeenCalled();
  } finally { cap.restore(); broken.mockRestore(); log.mockRestore(); }
});
