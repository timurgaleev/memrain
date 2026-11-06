/**
 * runtime_config writes and reports with both brand prefixes: `set` stores
 * every knob under its MEMRAIN_ name and leaves a legacy row alone, `unset` removes
 * a knob under both names (so a legacy row cannot come back through the
 * fallback), `unset --pattern` covers both spellings of a brand prefix, the
 * search-stats apply path goes through the same core writer, `get` names the
 * source it resolved from, and doctor lists legacy rows and env names by name
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";
import { legacyConfigDirCheck, legacyEnvCheck, runDoctor } from "../src/commands/doctor.ts";
import { applyTuneRecommendation } from "../src/commands/search-stats.ts";
import { Storage } from "../src/core/storage.ts";
import {
  classifyLegacyRows,
  getRuntimeConfig,
  listRuntimeConfig,
  setRuntimeConfig,
  unsetRuntimeConfigKeys,
} from "../src/core/runtime-config.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";
import { restoreExitCode } from "./helpers/exit-code.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-rc-write-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");
const dbPath = join(cfgDir, "brain.pglite");
const TOUCHED = [
  "RCW_A", "RCW_B", "S_A", "S_B", "QUERY_CACHE", "RCW_GET", "RCW_DOC_A", "RCW_DOC_B",
  "RCW_SET_A", "RCW_SET_B", "RCW_SET_C", "SEARCH_RCW",
];

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

async function withEngine<T>(fn: (s: Storage) => Promise<T>): Promise<T> {
  const s = new Storage({ dbPath });
  await s.init();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

async function keys(): Promise<string[]> {
  return withEngine(async (s) => (await listRuntimeConfig(s.engine())).map((r) => r.key));
}

async function seed(rows: Record<string, string>): Promise<void> {
  await withEngine(async (s) => {
    for (const [k, v] of Object.entries(rows)) await putRuntimeConfigRow(s.engine(), k, v);
  });
}

async function config(opts: Parameters<typeof runConfig>[0]): Promise<{ code: number; out: string; err: string }> {
  const c = capture();
  let code: number;
  try {
    code = await runConfig({ ...opts, configPath: cfgPath });
  } finally {
    c.restore();
  }
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}

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
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const s of TOUCHED) {
    delete process.env[`MEMRAIN_${s}`];
    delete process.env["MEMEX_" + s];
  }
});

async function rowsFor(suffix: string): Promise<{ key: string; value: string; updated_at: string }[]> {
  return withEngine(async (s) =>
    (await listRuntimeConfig(s.engine())).filter((r) => r.key === `MEMRAIN_${suffix}` || r.key === "MEMEX_" + suffix),
  );
}

describe("set stores the MEMRAIN_ name only", () => {
  it("core writer: a new-spelled set upserts MEMRAIN_X and leaves the MEMEX_X row byte-identical", async () => {
    await seed({ MEMEX_RCW_SET_A: "old" });
    const [before] = await rowsFor("RCW_SET_A");
    await withEngine(async (s) => {
      expect(await setRuntimeConfig(s.engine(), "MEMRAIN_RCW_SET_A", "new")).toBe("MEMRAIN_RCW_SET_A");
      expect(await setRuntimeConfig(s.engine(), "MEMRAIN_RCW_SET_A", "newer")).toBe("MEMRAIN_RCW_SET_A");
    });
    const after = await rowsFor("RCW_SET_A");
    expect(after.find((r) => r.key === "MEMEX_RCW_SET_A")).toEqual(before!);
    expect(after.find((r) => r.key === "MEMRAIN_RCW_SET_A")?.value).toBe("newer");
    // The legacy row is shadowed: the new row wins the read.
    const r = await config({ sub: "get", key: "MEMEX_RCW_SET_A" });
    expect(r.out).toBe("newer");
    expect(r.err).toContain("from runtime_config MEMRAIN_RCW_SET_A");
  });

  it("CLI: a legacy-spelled set is stored as MEMRAIN_X, with a note, and creates no MEMEX_ row", async () => {
    const r = await config({ sub: "set", key: "MEMEX_RCW_SET_B", value: "v" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Set MEMRAIN_RCW_SET_B = v");
    expect(r.err).toContain("MEMEX_RCW_SET_B is the pre-rename spelling; stored as MEMRAIN_RCW_SET_B");
    expect((await rowsFor("RCW_SET_B")).map((x) => x.key)).toEqual(["MEMRAIN_RCW_SET_B"]);
  });

  it("CLI: a new-spelled set prints no note", async () => {
    const r = await config({ sub: "set", key: "MEMRAIN_RCW_SET_C", value: "v" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Set MEMRAIN_RCW_SET_C = v");
    expect(r.err).not.toContain("pre-rename spelling");
    expect((await rowsFor("RCW_SET_C")).map((x) => x.key)).toEqual(["MEMRAIN_RCW_SET_C"]);
  });

  it("a --force key outside the knob alphabet is stored as given", async () => {
    const r = await config({ sub: "set", key: "MEMEX_lower", value: "v", force: true });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Set MEMEX_lower = v");
    await withEngine(async (s) => {
      expect(await getRuntimeConfig(s.engine(), "MEMEX_lower")).toBe("v");
      expect(await getRuntimeConfig(s.engine(), "MEMRAIN_lower")).toBeNull();
      await unsetRuntimeConfigKeys(s.engine(), "MEMEX_lower");
    });
  });

  it("search-stats apply: a legacy-spelled set recommendation writes only the MEMRAIN_ row", async () => {
    await seed({ MEMEX_SEARCH_RCW: "old" });
    const [before] = await rowsFor("SEARCH_RCW");
    await withEngine(async (s) => {
      await applyTuneRecommendation(s.engine(), {
        knob: "MEMEX_SEARCH_RCW",
        current: "old",
        suggested: "new",
        reason: "test",
        apply_command: "memex config set MEMEX_SEARCH_RCW new",
      });
    });
    const after = await rowsFor("SEARCH_RCW");
    expect(after.find((r) => r.key === "MEMRAIN_SEARCH_RCW")?.value).toBe("new");
    expect(after.find((r) => r.key === "MEMEX_SEARCH_RCW")).toEqual(before!);
  });
});

describe("unset removes a knob under both names", () => {
  it("core writer: both rows go in one call, then nothing resolves", async () => {
    await seed({ MEMRAIN_RCW_A: "new", MEMEX_RCW_A: "old" });
    await withEngine(async (s) => {
      expect(await unsetRuntimeConfigKeys(s.engine(), "MEMRAIN_RCW_A")).toEqual([
        "MEMEX_RCW_A",
        "MEMRAIN_RCW_A",
      ]);
      expect(await getRuntimeConfig(s.engine(), "MEMEX_RCW_A")).toBeNull();
    });
  });

  it("CLI: unset by the legacy spelling removes both; get then exits 1", async () => {
    await seed({ MEMRAIN_RCW_B: "new", MEMEX_RCW_B: "old" });
    const r = await config({ sub: "unset", key: "MEMEX_RCW_B" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Unset MEMEX_RCW_B, MEMRAIN_RCW_B");
    expect((await config({ sub: "get", key: "MEMRAIN_RCW_B" })).code).toBe(1);
    expect((await config({ sub: "get", key: "MEMEX_RCW_B" })).code).toBe(1);
  });
});

describe("unset --pattern", () => {
  for (const pattern of ["MEMRAIN_S_", "MEMEX_S_"]) {
    it(`${pattern} removes the suffix under both prefixes (no fallback revival)`, async () => {
      await seed({ MEMRAIN_S_A: "new", MEMEX_S_A: "old", MEMEX_S_B: "old-b" });
      const r = await config({ sub: "unset", pattern });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as { deleted: number; keys: string[] };
      expect(parsed.keys).toEqual(["MEMEX_S_A", "MEMEX_S_B", "MEMRAIN_S_A"]);
      expect(parsed.deleted).toBe(3);
      const left = await keys();
      expect(left.filter((k) => k.includes("_S_"))).toEqual([]);
      expect((await config({ sub: "get", key: "MEMRAIN_S_A" })).code).toBe(1);
    });
  }

  it("a pattern without a brand prefix keeps its literal meaning", async () => {
    await seed({ OTHER_S_A: "x", OTHERX_S_A: "y", MEMEX_S_A: "old" });
    const r = await config({ sub: "unset", pattern: "OTHER_" });
    const parsed = JSON.parse(r.out) as { keys: string[] };
    expect(parsed.keys).toEqual(["OTHER_S_A"]);
    const left = await keys();
    expect(left).toContain("OTHERX_S_A");
    expect(left).toContain("MEMEX_S_A");
    await withEngine(async (s) => {
      await unsetRuntimeConfigKeys(s.engine(), "OTHERX_S_A");
      await unsetRuntimeConfigKeys(s.engine(), "MEMEX_S_A");
    });
  });

  it("a brand word without the underscore is literal and leaves the other spelling", async () => {
    await seed({ MEMEX_LIT_A: "old", MEMRAIN_LIT_A: "new" });
    const r = await config({ sub: "unset", pattern: "MEMEX" });
    const parsed = JSON.parse(r.out) as { keys: string[] };
    expect(parsed.keys).toContain("MEMEX_LIT_A");
    expect(parsed.keys).not.toContain("MEMRAIN_LIT_A");
    expect(await keys()).toContain("MEMRAIN_LIT_A");
    await withEngine(async (s) => {
      await unsetRuntimeConfigKeys(s.engine(), "MEMRAIN_LIT_A");
    });
  });

  it("a --force key outside the knob alphabet is removed alone", async () => {
    await seed({ MEMEX_lit: "a", MEMRAIN_lit: "b" });
    await withEngine(async (s) => {
      expect(await unsetRuntimeConfigKeys(s.engine(), "MEMEX_lit")).toEqual(["MEMEX_lit"]);
      expect(await getRuntimeConfig(s.engine(), "MEMRAIN_lit")).toBe("b");
      await unsetRuntimeConfigKeys(s.engine(), "MEMRAIN_lit");
    });
  });
});

describe("search-stats apply goes through the same core writer", () => {
  it("an unset recommendation removes both spellings", async () => {
    await seed({ MEMRAIN_QUERY_CACHE: "0", MEMEX_QUERY_CACHE: "0" });
    await withEngine(async (s) => {
      await applyTuneRecommendation(s.engine(), {
        knob: "MEMEX_QUERY_CACHE",
        current: "0",
        suggested: "(unset)",
        reason: "test",
        apply_command: "memex config unset MEMEX_QUERY_CACHE",
      });
      const left = (await listRuntimeConfig(s.engine())).map((r) => r.key);
      expect(left.filter((k) => k.endsWith("_QUERY_CACHE"))).toEqual([]);
    });
  });
});

describe("get names the source it resolved from", () => {
  it("a legacy-only row resolves, and the stderr line names the row", async () => {
    await seed({ MEMEX_RCW_GET: "legacy-row" });
    const r = await config({ sub: "get", key: "MEMRAIN_RCW_GET" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("legacy-row");
    expect(r.err).toContain("MEMRAIN_RCW_GET from runtime_config MEMEX_RCW_GET");
  });

  it("a MEMRAIN_X row wins over the MEMEX_X row", async () => {
    await seed({ MEMRAIN_RCW_GET: "new-row" });
    const r = await config({ sub: "get", key: "MEMEX_RCW_GET" });
    expect(r.out).toBe("new-row");
    expect(r.err).toContain("from runtime_config MEMRAIN_RCW_GET");
  });

  it("a real env value wins over both rows", async () => {
    process.env["MEMEX_RCW_GET"] = "from-env";
    try {
      const r = await config({ sub: "get", key: "MEMRAIN_RCW_GET" });
      expect(r.out).toBe("from-env");
      expect(r.err).toContain("from env MEMEX_RCW_GET");
    } finally {
      delete process.env["MEMEX_RCW_GET"];
      delete process.env["MEMRAIN_RCW_GET"];
    }
  });
});

describe("doctor, names only", () => {
  it("classifies legacy-only and shadowed rows", () => {
    expect(
      classifyLegacyRows(["MEMEX_A", "MEMEX_B", "MEMRAIN_B", "MEMRAIN_C", "OTHER_D"]),
    ).toEqual({ legacyOnly: ["MEMEX_A"], shadowed: ["MEMEX_B"] });
  });

  it("warns on a legacy-only row and notes a shadowed one, never printing values", async () => {
    await seed({
      MEMEX_RCW_DOC_A: "value-legacy-only",
      MEMEX_RCW_DOC_B: "value-shadowed",
      MEMRAIN_RCW_DOC_B: "value-new",
    });
    const c = capture();
    const prevExit = process.exitCode;
    try {
      await runDoctor({ configPath: cfgPath, argv: [] });
    } finally {
      c.restore();
      restoreExitCode(prevExit);
    }
    const out = c.out.join("\n");
    const report = JSON.parse(out) as {
      checks: { name: string; ok: boolean; status: string; detail: string }[];
    };
    const check = report.checks.find((x) => x.name === "runtime-config-legacy-rows")!;
    expect(check.status).toBe("warn");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("MEMEX_RCW_DOC_A");
    expect(check.detail).toContain("shadowed legacy row(s), inert: MEMEX_RCW_DOC_B");
    expect(out).not.toContain("value-");
  });

  it("warns on mapped legacy env names, by legacy name only", () => {
    expect(legacyEnvCheck({ mapped: [], conflicts: ["MEMRAIN_X"] }).status).toBe("ok");
    const c = legacyEnvCheck({ mapped: ["MEMRAIN_A", "MEMRAIN_B"], conflicts: [] });
    expect(c.status).toBe("warn");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("MEMEX_A, MEMEX_B");
  });

  it("warns on a separate ~/.memex beside ~/.memrain, not on one directory under both names", () => {
    const home = mkdtempSync(join(tmp, "home-"));
    expect(legacyConfigDirCheck(home).status).toBe("ok");
    mkdirSync(join(home, ".memrain"));
    expect(legacyConfigDirCheck(home).status).toBe("ok");
    symlinkSync(join(home, ".memrain"), join(home, ".memex"));
    expect(legacyConfigDirCheck(home).status).toBe("ok");
    const split = mkdtempSync(join(tmp, "home-"));
    mkdirSync(join(split, ".memrain"));
    mkdirSync(join(split, ".memex"));
    const c = legacyConfigDirCheck(split);
    expect(c.status).toBe("warn");
    expect(c.ok).toBe(true);
  });
});
