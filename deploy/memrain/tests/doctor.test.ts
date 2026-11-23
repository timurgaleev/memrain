/**
 * Doctor smoke — runs against a fresh PGLite + a config in tmp dir, so
 * it never reaches Bedrock or the live brain. Captures stdout, parses
 * the JSON report, asserts the expected check shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, engineCheckDetail } from "../src/commands/doctor.ts";
import { Storage } from "../src/core/storage.ts";
import { VERSION } from "../src/version.ts";
import packageJson from "../package.json" with { type: "json" };
import { restoreExitCode } from "./helpers/exit-code.ts";

/** One check as the report renders it. */
interface ReportedCheck {
  name: string;
  ok: boolean;
  status: "ok" | "warn" | "fail";
  detail?: string;
  category: string;
}

interface Report {
  ok: boolean;
  status: "ok" | "warn" | "fail";
  version: string;
  checks: ReportedCheck[];
  summary: {
    by_category: Record<string, { ok: number; fail: number }>;
    ranked_failures: { name: string; tier: string; downstream_of?: string }[];
  };
}

/** Run the real doctor against `cfg` and capture the report + exit code. */
async function report(cfg: string): Promise<{ parsed: Report; exitCode: number | undefined }> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  let exitCode: number | undefined;
  try {
    await runDoctor({ configPath: cfg });
    exitCode = process.exitCode;
  } finally {
    console.log = origLog;
    restoreExitCode(prevExit);
  }
  return { parsed: JSON.parse(captured.join("\n")) as Report, exitCode };
}

const tmp = mkdtempSync(join(tmpdir(), "memrain-doctor-test-"));
const cfgDir = join(tmp, ".memex");
const dbPath = join(cfgDir, "brain.pglite");
const cfgPath = join(cfgDir, "config.json");

const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  // Unset any MEMRAIN_VAULT_PATH from the parent env so the vault check
  // stays in its "not configured" branch (we pass configPath explicitly
  // because os.homedir() caches at process start in Bun).
  originalEnv.MEMRAIN_VAULT_PATH = process.env.MEMRAIN_VAULT_PATH;
  delete process.env.MEMRAIN_VAULT_PATH;
});

afterAll(() => {
  // Restore env we mutated.
  if (originalEnv.MEMRAIN_VAULT_PATH !== undefined) {
    process.env.MEMRAIN_VAULT_PATH = originalEnv.MEMRAIN_VAULT_PATH;
  }
  rmSync(tmp, { recursive: true, force: true });
});


/**
 * Build a brain, run `breakSql` against it (renaming a table or a column makes
 * the probe raise the very `relation/column … does not exist` a half-migrated
 * brain raises), then run the real doctor over it. This is what makes the catch
 * paths reachable at all: without it nothing but a live schema accident ever
 * entered those branches, and a mutation there would survive for lack of a
 * fixture rather than for lack of a bug.
 */
async function brokenBrainReport(
  dir: string,
  breakSql: string[],
): Promise<{ parsed: Report; exitCode: number | undefined }> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "brain.pglite");
  const cfg = join(dir, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  const s = new Storage({ dbPath });
  await s.init();
  for (const sql of breakSql) await s.engine().query(sql);
  await s.close();
  return report(cfg);
}

/** `ALTER TABLE x RENAME TO x_hidden` — the table vanishes for every reader. */
const hideTable = (t: string) => `ALTER TABLE ${t} RENAME TO ${t}_hidden`;



/** Every `catch (…) { … }` body in a source file, brace-matched. */
function catchBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\bcatch\b\s*(\([^)]*\)\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

describe("doctor catch-path drift guard", () => {
  // Same spirit as the category drift guard: a future check must not be able to
  // re-introduce "a throw renders as a pass". Every catch that records a check
  // goes through `couldNotCheck` (warn) or `verdict(name, false, …)` (fail) —
  // never a hand-rolled ok.
  it("no catch block in commands/doctor.ts records a passing check", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/commands/doctor.ts"),
      "utf8",
    );
    const blocks = catchBlocks(src);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const b of blocks) {
      expect(b).not.toContain("ok: true");
      expect(b).not.toContain('status: "ok"');
      if (b.includes("checks.push")) {
        const routed =
          b.includes("couldNotCheck(") || /verdict\(\s*"[a-z-]+",\s*false/.test(b);
        expect(routed).toBe(true);
      }
    }
  });

  it("no catch block in the MCP doctor tool records a passing check", () => {
    // run_doctor runs the shared engine checks (core/lite-doctor.ts).
    const body = readFileSync(join(import.meta.dir, "../src/core/lite-doctor.ts"), "utf8");
    expect(catchBlocks(body).length).toBeGreaterThan(0);
    for (const b of catchBlocks(body)) {
      expect(b).not.toContain("ok: true");
      expect(b).not.toContain('status: "ok"');
    }
  });
});

describe("doctor engine check detail", () => {
  it("names the data dir on pglite and the engine kind otherwise", async () => {
    // `detail: config.database.path` read `path` off the config UNION. It only
    // exists on the pglite variant, so on the postgres brain that actually runs
    // in production the field serialised as undefined and vanished from the
    // report — the one check whose whole job is naming the engine said nothing
    // about it. The catch path a few lines below always narrowed correctly.
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      await runDoctor({ configPath: cfgPath });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(captured.join("\n")) as {
      checks: { name: string; detail?: string }[];
    };
    const engine = parsed.checks.find((c) => c.name === "pglite");
    expect(engine?.detail).toBe(dbPath);
  });

  // Driving runDoctor can only ever exercise the pglite side without a live
  // postgres — and the postgres side is where the bug was. Pin both variants
  // on the pure function instead, so the branch is observable at all.
  it("names the engine kind on a postgres config", () => {
    expect(engineCheckDetail({ type: "pglite", path: "/tmp/brain.pglite" })).toBe(
      "/tmp/brain.pglite",
    );
    expect(engineCheckDetail({ type: "postgres" })).toBe("engine=postgres");
    expect(
      engineCheckDetail({ type: "postgres", url: "postgres://host/db" }),
    ).toBe("engine=postgres");
  });
});

it("reports suspected JSON encoding and version storage without source text", async () => {
  const storage = new Storage({ dbPath });
  await storage.init();
  try {
    await storage.engine().query(`INSERT INTO pages (slug, type, title, markdown_body, content_hash, compiled_truth)
      VALUES ('notes/json-candidate', 'note', 'Candidate', 'PRIVATE PAGE TEXT', 'h', $1::text::jsonb)`,
      [JSON.stringify(JSON.stringify({ value: "PRIVATE VALUE" }))]);
    await storage.engine().query(`INSERT INTO page_versions (slug, version_n, hash_new, body_snapshot, compiled_truth_snapshot)
      VALUES ('notes/json-candidate', 1, 'h', 'PRIVATE OLD TEXT', '{}')`);
  } finally { await storage.close(); }
  const { parsed } = await report(cfgPath);
  const json = parsed.checks.find(c => c.name === "jsonb-integrity");
  const versions = parsed.checks.find(c => c.name === "page-version-storage");
  expect(json).toMatchObject({ ok: true, status: "warn" });
  expect(json?.detail).toContain("pages.compiled_truth=1");
  expect(versions).toMatchObject({ ok: true, status: "ok" });
  expect(versions?.detail).toContain("notes/json-candidate");
  expect(JSON.stringify([json, versions])).not.toContain("PRIVATE");
  expect(parsed.checks.find(c => c.name === "db-backends")).toMatchObject({ ok: true, status: "ok" });
});
