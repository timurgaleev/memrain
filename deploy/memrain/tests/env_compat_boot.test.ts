/**
 * The env shim at process start: a host that still sets only the legacy
 * MEMEX_* names must resolve every knob exactly as one that sets MEMRAIN_*.
 *
 * These spawn real processes because the shim only works as the FIRST import
 * of an entry point; nothing in-process can show that order. The tests
 * themselves run without the shim, so a reader the rename missed fails here
 * or in its own test rather than silently falling back to a default.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const PROBE = join(import.meta.dir, "fixtures", "env-probe.ts");

function run(argv: string[], env: Record<string, string>): { code: number; out: string; err: string } {
  const home = mkdtempSync(join(tmpdir(), "env-compat-boot-"));
  try {
    const p = Bun.spawnSync(["bun", ...argv], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function probe(env: Record<string, string>): Record<string, unknown> {
  const r = run([PROBE], env);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as Record<string, unknown>;
}

function withPrefix(prefix: string, knobs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(knobs).map(([k, v]) => [prefix + k, v]));
}

const KNOBS = {
  POSTGRES_URL: "postgres://u:p@127.0.0.1:1/probe?sslmode=disable",
  PUBLIC_URL: "https://brain.example.com/",
  OAUTH_REQUIRE_LOGIN: "0",
  PUBLIC_WRITE: "1",
  TENANT_FAIL_CLOSED: "1",
  MAINTENANCE: "0",
  BOOT_CODE_SWEEP: "0",
  JOBS_WORKER: "0",
  CYCLE: "0",
  EXPANSION_MODEL: "probe-expansion-model",
};

describe("env shim at process start", () => {
  it("MEMEX_VERSION reaches the version stamp, the one import-time env read", () => {
    const r = run(["src/cli.ts", "--version"], { MEMEX_VERSION: "x" });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("memrain x");
  });

  it("legacy-only and new-only env resolve to the same values", () => {
    const legacy = probe(withPrefix("MEMEX_", KNOBS));
    const current = probe(withPrefix("MEMRAIN_", KNOBS));
    expect(legacy).toEqual(current);
    expect(current).toEqual({
      postgresUrl: KNOBS.POSTGRES_URL,
      engine: "PostgresEngine",
      issuer: "https://brain.example.com",
      oauthRequireLogin: false,
      publicWrite: true,
      tenantFailClosed: true,
      quiescence: { maintenance: false, bootCodeSweep: false, jobsWorker: false, cycle: false, invalid: [] },
      expansionModel: KNOBS.EXPANSION_MODEL,
    });
  });

  it("every probed value differs from its default, so the comparison is not vacuous", () => {
    const unset = probe({});
    const set = probe(withPrefix("MEMEX_", KNOBS));
    for (const key of Object.keys(set)) {
      expect({ key, value: unset[key] }).not.toEqual({ key, value: set[key] });
    }
  });

  it("legacy MEMEX_MAINTENANCE=1 turns maintenance on like MEMRAIN_MAINTENANCE=1", () => {
    const legacy = probe({ MEMEX_MAINTENANCE: "1" });
    const current = probe({ MEMRAIN_MAINTENANCE: "1" });
    expect(legacy.quiescence).toEqual(current.quiescence);
    expect(current.quiescence).toEqual({
      maintenance: true,
      bootCodeSweep: false,
      jobsWorker: false,
      cycle: false,
      invalid: [],
    });
  });
});
