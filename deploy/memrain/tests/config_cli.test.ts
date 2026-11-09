/**
 * `memrain config show|get|set|unset` — the CLI wrapper over runtime_config:
 * key-alphabet gate, redacted show, --pattern bulk unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-config-cli-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

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
  // The Storage.init overlay may have projected the stored keys onto this
  // process's env — scrub so later test files never see them.
  for (const k of ["SEARCH_MODE", "INTERNAL_TOKEN"]) {
    delete process.env["MEMEX_" + k];
    delete process.env[`MEMRAIN_${k}`];
  }
});

describe("memrain config CLI", () => {
  it("set + get round-trips a MEMRAIN_* key", async () => {
    const c1 = capture();
    let code: number;
    try {
      code = await runConfig({
        sub: "set",
        key: "MEMRAIN_SEARCH_MODE",
        value: "balanced",
        configPath: cfgPath,
      });
    } finally {
      c1.restore();
    }
    expect(code).toBe(0);
    const c2 = capture();
    try {
      code = await runConfig({ sub: "get", key: "MEMRAIN_SEARCH_MODE", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    expect(code).toBe(0);
    expect(c2.out.join("")).toBe("balanced");
  });

  it("rejects a non-MEMEX key without --force", async () => {
    const c = capture();
    let code: number;
    try {
      code = await runConfig({
        sub: "set",
        key: "PATH",
        value: "/evil",
        configPath: cfgPath,
      });
    } finally {
      c.restore();
    }
    expect(code).toBe(2);
    expect(c.err.join("\n")).toContain("knob alphabet");
  });

  it("show redacts sensitive values", async () => {
    const c1 = capture();
    try {
      await runConfig({
        sub: "set",
        key: "MEMRAIN_INTERNAL_TOKEN",
        value: "supersecret",
        configPath: cfgPath,
      });
    } finally {
      c1.restore();
    }
    // The set confirmation itself must not echo the secret.
    expect(c1.out.join("\n")).not.toContain("supersecret");
    const c2 = capture();
    try {
      await runConfig({ sub: "show", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    const shown = JSON.parse(c2.out.join("\n"));
    const row = shown.entries.find((e: { key: string }) => e.key === "MEMRAIN_INTERNAL_TOKEN");
    expect(row.value).toBe("***");
  });

  it("rejects typos, canonicalizes flags, and warns when actual env wins", async () => {
    const c = capture();
    const previous = process.env.MEMRAIN_GRAPH_SIGNALS;
    process.env.MEMRAIN_GRAPH_SIGNALS = "0";
    try {
      expect(await runConfig({ sub: "set", key: "MEMRAIN_GRAPH_SIGNAL", value: "true", configPath: cfgPath })).toBe(2);
      expect(c.err.join("\n")).toContain("did you mean MEMRAIN_GRAPH_SIGNALS");
      expect(await runConfig({ sub: "set", key: "MEMRAIN_GRAPH_SIGNALS", value: "true", configPath: cfgPath })).toBe(0);
      expect(c.out.join("\n")).toContain("MEMRAIN_GRAPH_SIGNALS = 1");
      expect(c.err.join("\n")).toContain("environment");
      expect(c.err.join("\n")).toContain("restart");
      expect(await runConfig({ sub: "set", key: "MEMRAIN_GRAPH_SIGNALS", value: "perhaps", force: true, configPath: cfgPath })).toBe(2);
      expect(await runConfig({ sub: "set", key: "MEMRAIN_PG_POOL_MAX", value: "2.5", configPath: cfgPath })).toBe(2);
      expect(await runConfig({ sub: "set", key: "MEMRAIN_FUTURE_KNOB", value: "custom", force: true, configPath: cfgPath })).toBe(0);
      await runConfig({ sub: "show", configPath: cfgPath });
      const rows = JSON.parse(c.out.at(-1)!).entries;
      expect(rows.find((r: { key: string }) => r.key === "MEMRAIN_GRAPH_SIGNAL")).toBeUndefined();
      expect(rows.find((r: { key: string }) => r.key === "MEMRAIN_GRAPH_SIGNALS").value).toBe("1");
    } finally {
      c.restore();
      if (previous === undefined) delete process.env.MEMRAIN_GRAPH_SIGNALS;
      else process.env.MEMRAIN_GRAPH_SIGNALS = previous;
      delete process.env.MEMRAIN_FUTURE_KNOB;
    }
  });

  it("unset --pattern bulk-deletes by prefix; get on a gone key exits 1", async () => {
    const c1 = capture();
    let code: number;
    try {
      code = await runConfig({ sub: "unset", pattern: "MEMEX_", configPath: cfgPath });
    } finally {
      c1.restore();
    }
    expect(code).toBe(0);
    const deleted = JSON.parse(c1.out.join("\n"));
    expect(deleted.deleted).toBeGreaterThanOrEqual(2);
    const c2 = capture();
    try {
      code = await runConfig({ sub: "get", key: "MEMRAIN_SEARCH_MODE", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    expect(code).toBe(1);
  });
});
