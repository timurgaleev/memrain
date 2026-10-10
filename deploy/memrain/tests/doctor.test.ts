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
import { KNOWN_CHECK_NAMES } from "../src/core/doctor-categories.ts";
import { Storage } from "../src/core/storage.ts";
import { VERSION } from "../src/version.ts";
import packageJson from "../package.json" with { type: "json" };

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
    process.exitCode = prevExit;
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

describe("doctor", () => {
  it("reports ok on a freshly initialised pglite + no vault", async () => {
    const { parsed, exitCode } = await report(cfgPath);
    if (!parsed.ok) {
      // Surface which check failed when the assertion below fires.
      console.error("doctor failure detail:", JSON.stringify(parsed, null, 2));
    }
    expect(parsed.ok).toBe(true);
    // The BUILD stamp, not package.json — which is pinned at 0.1.0, so the
    // old `\d+.\d+.\d+` assertion passed on a constant that could never
    // change. Unstamped in a test process, the honest answer is "dev".
    expect(parsed.version).toBe(VERSION);
    expect(parsed.version).not.toBe(packageJson.version);
    const names = parsed.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      "chronicle-projection-health",
      "chunker-version-lag",
      "code-grammars",
      "config",
      "config-yml",
      "connector-health",
      "contradiction-trend",
      "cycle-freshness",
      "document-id-drift",
      "duplicate-pages",
      "embed-backlog",
      "embedding-width",
      "eval-trend",
      "federation-health",
      "index-spread",
      "invalid-indexes",
      "junk-entity-hubs",
      "legacy-config-dir",
      "legacy-env-names",
      "links-extraction-lag",
      "oauth-client-health",
      "oauth-client-hygiene",
      "oauth-self-issued-config",
      "pat-scopes-recorded",
      "pglite",
      "quarantined-pages",
      "queue-health",
      "runtime-config-legacy-rows",
      "schema-version",
      "source-health",
      "source-routing-health",
      "stale-locks",
      "stats",
      "vault",
    ]);
    // The eval-trend check is informational (ok) and reports the not-yet-run
    // state on a fresh brain where the probe has never appended a snapshot.
    const evalTrend = parsed.checks.find((c) => c.name === "eval-trend")!;
    expect(evalTrend.ok).toBe(true);
    expect(evalTrend.status).toBe("ok");
    expect(evalTrend.detail).toMatch(/has not run yet/);
    expect(exitCode).toBe(0);

    // A fresh brain has never run its maintenance cycle, which is now an
    // honest warn rather than silent green — and the whole point of the warn
    // tier is that it does NOT flip the exit code (asserted above).
    const cycle = parsed.checks.find((c) => c.name === "cycle-freshness")!;
    expect(cycle.ok).toBe(true);
    expect(cycle.status).toBe("warn");
    expect(parsed.status).toBe("warn"); // worst check wins, as CycleResult rolls up

    // Every check carries a category, and — the DRIFT GUARD — every name the
    // doctor actually emits is in the categorization single-source-of-truth
    // (so a future check added without categorizing it fails here).
    for (const c of parsed.checks) {
      expect(["brain", "ops", "meta"]).toContain(c.category);
      expect(KNOWN_CHECK_NAMES.has(c.name)).toBe(true);
      // Every check carries a verdict, and `ok` is only its exit-code view.
      expect(["ok", "warn", "fail"]).toContain(c.status);
      expect(c.ok).toBe(c.status !== "fail");
    }
    // Healthy run → no ranked failures; category rollup present.
    expect(parsed.summary.ranked_failures).toEqual([]);
    expect(parsed.summary.by_category.brain).toBeDefined();
    const ops = parsed.summary.by_category.ops;
    expect(ops).toBeDefined();
    expect(ops!.ok).toBeGreaterThan(0);
  });
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

describe("doctor checks that could not run", () => {
  it("reports every unreadable probe as a warn — and still exits 0", async () => {
    const { parsed, exitCode } = await brokenBrainReport(join(tmp, "hidden-soft"), [
      hideTable("cycle_snapshots"),
      hideTable("synth_contradiction_runs"),
      hideTable("timeline_events"),
      hideTable("cycle_locks"),
      hideTable("pages"),
      // `latestEvalSnapshot` deliberately degrades a MISSING TABLE to "probe
      // has not run yet" (a pre-mig-068 brain is not an error), so hiding the
      // table would never reach the doctor's catch. A renamed column is the
      // half-migrated schema that does.
      "ALTER TABLE eval_snapshots RENAME COLUMN mean_rr TO mean_rr_gone",
    ]);
    for (const name of [
      "cycle-freshness",
      "eval-trend",
      "contradiction-trend",
      "chronicle-projection-health",
      "stale-locks",
      "links-extraction-lag",
      "duplicate-pages",
    ]) {
      const c = parsed.checks.find((x) => x.name === name)!;
      expect(c).toBeDefined();
      // The bug this pins: a check that THREW used to render byte-identical to
      // one that passed.
      expect(c.status).toBe("warn");
      expect(c.detail).toStartWith(`could not check ${name}: `);
      expect(c.ok).toBe(true);
    }
    // Nothing here is a real failure, so the cron contract holds: warns roll up
    // into `status` and leave the exit code alone.
    expect(parsed.status).toBe("warn");
    expect(parsed.ok).toBe(true);
    expect(exitCode).toBe(0);
  }, 30_000);

  it("warns on the document-backed probes while the genuinely broken ones fail", async () => {
    process.env.MEMRAIN_DOCTOR_PER_SOURCE = "1";
    let out: { parsed: Report; exitCode: number | undefined };
    try {
      out = await brokenBrainReport(join(tmp, "hidden-docs"), [
        hideTable("documents"),
      ]);
    } finally {
      delete process.env.MEMRAIN_DOCTOR_PER_SOURCE;
    }
    const { parsed, exitCode } = out;
    for (const name of ["chunker-version-lag", "per-source-embed-coverage"]) {
      const c = parsed.checks.find((x) => x.name === name)!;
      expect(c.status).toBe("warn");
      expect(c.detail).toStartWith(`could not check ${name}: `);
    }
    // `stats` reads the core table directly: that one IS a broken brain, and it
    // keeps failing the exit code (a warn tier must not soften a real fault).
    const stats = parsed.checks.find((x) => x.name === "stats")!;
    expect(stats.status).toBe("fail");
    expect(stats.ok).toBe(false);
    expect(parsed.status).toBe("fail");
    expect(parsed.ok).toBe(false);
    expect(exitCode).toBe(1);
  }, 30_000);
});

describe("doctor per-source embed coverage", () => {
  it("warns (never fails) on a source stuck at 0% coverage", async () => {
    process.env.MEMRAIN_DOCTOR_PER_SOURCE = "1";
    let out: { parsed: Report; exitCode: number | undefined };
    try {
      // A source whose chunks exist but were never embedded — the tenant that
      // is invisibly dead inside the whole-brain average.
      out = await brokenBrainReport(join(tmp, "unembedded"), [
        "INSERT INTO sources (id, kind, path_prefix) VALUES ('vault', 'vault', 'vault/')",
        `INSERT INTO documents (id, source_id, source_path, title, frontmatter, updated_at)
           VALUES ('d1', 'vault', 'vault/d1.md', 'D1', '{}'::jsonb, NOW())`,
        `INSERT INTO chunks (id, document_id, chunk_index, content)
           VALUES ('d1-c0', 'd1', 0, 'body')`,
      ]);
    } finally {
      delete process.env.MEMRAIN_DOCTOR_PER_SOURCE;
    }
    const c = out.parsed.checks.find((x) => x.name === "per-source-embed-coverage")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("vault");
    expect(c.ok).toBe(true); // mid-backfill is legitimate — it must not gate
    expect(out.exitCode).toBe(0);
  }, 30_000);
});

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
    expect(blocks.length).toBeGreaterThanOrEqual(8);
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
    const src = readFileSync(join(import.meta.dir, "../src/mcp/dispatch.ts"), "utf8");
    // callRunDoctor only — the rest of dispatch.ts is not a health report.
    const start = src.indexOf("async function callRunDoctor");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
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
