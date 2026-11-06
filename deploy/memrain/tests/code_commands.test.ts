/**
 * code-* CLI command tests — exercise the SQL queries via runCode().
 * Spies on console.log to capture the JSON output.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { runCode } from "../src/commands/code.ts";
import { loadConfig } from "../src/core/config.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { restoreExitCode } from "./helpers/exit-code.ts";

const dbDir = mkdtempSync(join(tmpdir(), "tb-code-cmd-db-"));
const repoDir = mkdtempSync(join(tmpdir(), "tb-code-cmd-repo-"));
let storage: Storage;
const origConfigPath = process.env.MEMRAIN_CONFIG_PATH;

beforeAll(async () => {
  // Point loadConfig() at our temp config via MEMRAIN_CONFIG_PATH —
  // Bun's homedir() doesn't honor HOME overrides.
  const cfgDir = join(dbDir, ".memex");
  mkdirSync(cfgDir, { recursive: true });
  const pgPath = join(cfgDir, "brain.pglite");
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: pgPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  process.env.MEMRAIN_CONFIG_PATH = cfgPath;

  storage = new Storage({ dbPath: pgPath });
  await storage.init();

  // Seed two TS files where beta() calls alpha().
  writeFileSync(
    join(repoDir, "alpha.ts"),
    `export function alpha() { return 1; }\n`,
  );
  writeFileSync(
    join(repoDir, "beta.ts"),
    `import { alpha } from "./alpha";
export function beta() { return alpha(); }
`,
  );
  await indexCodeFile(storage, join(repoDir, "alpha.ts"));
  await indexCodeFile(storage, join(repoDir, "beta.ts"));
  await storage.close();
});

afterAll(() => {
  if (origConfigPath) process.env.MEMRAIN_CONFIG_PATH = origConfigPath;
  else delete process.env.MEMRAIN_CONFIG_PATH;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  _resetParsersForTests();
});

interface JsonOutput {
  ok?: boolean;
  count?: number;
  query?: { type?: string; name?: string };
  mentions?: Array<{ surface_form: string }>;
  error?: string;
}

async function runAndCapture(
  opts: Parameters<typeof runCode>[0],
): Promise<{ stdout: string; parsed: JsonOutput | null }> {
  let captured = "";
  const origLog = console.log;
  const origExitCode = process.exitCode;
  console.log = mock((...args: unknown[]) => {
    captured += args.join(" ") + "\n";
  });
  try {
    await runCode({ ...opts, json: true });
  } finally {
    console.log = origLog;
  }
  let parsed: JsonOutput | null = null;
  try {
    parsed = JSON.parse(captured);
  } catch {
    // not JSON, that's fine
  }
  // restore
  restoreExitCode(origExitCode);
  return { stdout: captured, parsed };
}

describe("runCode", () => {
  it("code-def alpha returns one mention in alpha.ts", async () => {
    const { parsed } = await runAndCapture({ sub: "code-def", name: "alpha" });
    expect(parsed?.ok).toBe(true);
    expect(parsed?.count).toBeGreaterThanOrEqual(1);
    expect(parsed?.mentions?.[0]?.surface_form).toContain("alpha.ts");
  });

  it("code-callers alpha returns beta as the caller", async () => {
    const { parsed } = await runAndCapture({ sub: "code-callers", name: "alpha" });
    expect(parsed?.ok).toBe(true);
    const sf = parsed?.mentions?.map((m) => m.surface_form) ?? [];
    expect(sf.some((s) => s.endsWith(":beta"))).toBe(true);
  });

  it("code-refs alpha finds the import line", async () => {
    const { parsed } = await runAndCapture({ sub: "code-refs", name: "alpha" });
    expect(parsed?.ok).toBe(true);
    expect((parsed?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("code-callees on beta.ts:2 returns alpha as the callee target", async () => {
    const target = `${join(repoDir, "beta.ts")}:2`;
    const { parsed } = await runAndCapture({ sub: "code-callees", target });
    expect(parsed?.ok).toBe(true);
    const sf = parsed?.mentions?.map((m) => m.surface_form) ?? [];
    expect(sf.some((s) => s.startsWith("alpha@"))).toBe(true);
  });

  it("code-callees on a line outside any symbol errors clearly", async () => {
    const target = `${join(repoDir, "beta.ts")}:9999`;
    const { parsed } = await runAndCapture({ sub: "code-callees", target });
    expect(parsed?.ok).toBe(false);
    expect(parsed?.error).toContain("no code symbol covers");
  });

  it("an empty lookup names the index state on stderr and leaves stdout unchanged", async () => {
    let errOut = "";
    const origErr = console.error;
    console.error = mock((...args: unknown[]) => {
      errOut += args.join(" ") + "\n";
    });
    try {
      const { parsed } = await runAndCapture({ sub: "code-def", name: "zzNoSuchSymbol" });
      expect(parsed).toEqual({
        ok: true,
        count: 0,
        query: { type: "code-def", name: "zzNoSuchSymbol" },
        mentions: [],
      });
    } finally {
      console.error = origErr;
    }
    expect(errOut).toMatch(/^no results — code index: ready \(2 code documents, \d+ symbols\)\n$/);
  });
});
