/**
 * The `--json` guard: whatever a guarded command prints, stdout ends up as
 * exactly ONE JSON object, so `JSON.parse(stdout)` is all a script or an agent
 * needs. These pin the rendering rules in-process; the spawned contract over
 * the real entrypoint lives in cli_json_contract.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { renderJsonDocument, runJsonGuarded } from "../src/cli-json.ts";
import { OperationError } from "../src/core/operation-error.ts";

function parseOne(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  expect(value !== null && typeof value === "object" && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

describe("renderJsonDocument", () => {
  it("passes a command's own JSON object through byte for byte", () => {
    const own = `{\n  "ok": true,\n  "rows": []\n}\n`;
    const out = renderJsonDocument({ stdout: own, stderr: "" }, { code: 0 });
    expect(out.stdout).toBe(own);
    expect(out.stderr).toBe("");
  });

  it("keeps a non-zero command's own JSON object as it is", () => {
    const own = `{"error":"not_found","error_class":"not_found","retryable":false}\n`;
    expect(renderJsonDocument({ stdout: own, stderr: "" }, { code: 1 }).stdout).toBe(own);
  });

  it("wraps prose as text instead of guessing at its structure", () => {
    const out = renderJsonDocument({ stdout: "memrain dev\n", stderr: "" }, { code: 0 });
    expect(parseOne(out.stdout)).toEqual({ ok: true, data: { text: "memrain dev" } });
  });

  it("wraps two JSON documents in a row, which JSON.parse would refuse", () => {
    const out = renderJsonDocument({ stdout: `{"a":1}\n{"b":2}\n`, stderr: "" }, { code: 0 });
    expect(parseOne(out.stdout)).toEqual({ ok: true, data: { text: `{"a":1}\n{"b":2}` } });
  });

  it("wraps a JSON array, because the contract is one object", () => {
    const out = renderJsonDocument({ stdout: `[1,2]\n`, stderr: "" }, { code: 0 });
    expect(parseOne(out.stdout)).toEqual({ ok: true, data: [1, 2] });
  });

  it("reports empty output as ok with null data", () => {
    const out = renderJsonDocument({ stdout: "", stderr: "progress\n" }, { code: 0 });
    expect(parseOne(out.stdout)).toEqual({ ok: true, data: null });
  });

  it("turns a non-zero exit with no JSON into an error object carrying the stderr message", () => {
    const out = renderJsonDocument(
      { stdout: "", stderr: "memrain search: <query> is required\n" },
      { code: 1 },
    );
    expect(parseOne(out.stdout)).toEqual({
      ok: false,
      error: { message: "memrain search: <query> is required" },
      exit_code: 1,
    });
  });

  it("classifies a structured error and links its catalogue entry", () => {
    const err = new OperationError("invalid_params", "bad --k");
    const out = renderJsonDocument({ stdout: "", stderr: "" }, { error: err });
    expect(parseOne(out.stdout)).toEqual({
      ok: false,
      error: {
        code: "invalid_params",
        error_class: "invalid_request",
        retryable: false,
        message: "bad --k",
        docs: "docs/ERRORS.md#invalid_params",
      },
      exit_code: 2,
    });
  });

  it("gives a retryable structured error the tempfail exit code", () => {
    const out = renderJsonDocument({ stdout: "", stderr: "" }, { error: new OperationError("db_busy", "busy") });
    const doc = parseOne(out.stdout);
    expect(doc.exit_code).toBe(75);
    expect((doc.error as { retryable: boolean }).retryable).toBe(true);
  });

  it("reports an unstructured throw by message, and moves partial stdout to stderr", () => {
    const out = renderJsonDocument({ stdout: "half a report\n", stderr: "" }, { error: new Error("boom") });
    expect(parseOne(out.stdout)).toEqual({ ok: false, error: { message: "boom" }, exit_code: 1 });
    expect(out.stderr).toBe("half a report\n");
  });

  it("never echoes a raw database error, only its sanitized class", () => {
    const raw = Object.assign(new Error("canceling statement due to statement timeout on host db.internal"), { code: "57014" });
    const doc = parseOne(renderJsonDocument({ stdout: "", stderr: "" }, { error: raw }).stdout);
    expect(JSON.stringify(doc)).not.toContain("db.internal");
    expect((doc.error as { code: string }).code).toBe("db_timeout");
  });
});

describe("runJsonGuarded", () => {
  const realLog = console.log;
  const realWrite = process.stdout.write.bind(process.stdout);
  afterEach(() => {
    console.log = realLog;
    process.stdout.write = realWrite;
  });

  function collectStdout(): string[] {
    const chunks: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    return chunks;
  }

  it("captures console.log and stdout writes and emits one object at the end", async () => {
    const chunks = collectStdout();
    const code = await runJsonGuarded(async () => {
      console.log("line one");
      process.stdout.write("line two\n");
      return 0;
    });
    expect(code).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(parseOne(chunks[0]!)).toEqual({ ok: true, data: { text: "line one\nline two" } });
  });

  it("restores the real writers even when the command throws, and rethrows", async () => {
    const chunks = collectStdout();
    const write = process.stdout.write;
    await expect(runJsonGuarded(async () => {
      throw new OperationError("not_found", "no page");
    })).rejects.toThrow("no page");
    expect(process.stdout.write).toBe(write);
    expect(console.log).toBe(realLog);
    expect(parseOne(chunks.join("")).ok).toBe(false);
  });
});
