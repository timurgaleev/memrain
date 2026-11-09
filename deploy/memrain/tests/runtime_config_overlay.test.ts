/**
 * runtime_config overlay with both brand prefixes. Pins the precedence (env
 * MEMRAIN_X, env MEMEX_X, row MEMRAIN_X, row MEMEX_X), the projection under
 * both names while readers still use the legacy one, the kill switches, the
 * key alphabet and the env-only knobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  applyRuntimeEnvOverlay,
  runtimeOverlayState,
  canonicalKey,
  isRuntimeConfigKey,
  legacyKey,
  resolveRuntimeConfig,
  setRuntimeConfig,
  unsetRuntimeConfig,
} from "../src/core/runtime-config.ts";
import { checkRuntimeConfigOverlay } from "../src/core/doctor-ops.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";

const dir = mkdtempSync(join(tmpdir(), "memrain-rc-overlay-"));
let storage: Storage;
const SUFFIXES = ["RCO_A", "RCO_B", "RCO_C", "RCO_D", "RCO_E", "RCO_F", "RCO_G", "MAINTENANCE"];

function clearEnv(): void {
  for (const s of SUFFIXES) {
    delete process.env[`MEMRAIN_${s}`];
    delete process.env["MEMEX_" + s];
  }
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterEach(async () => {
  const e = storage.engine();
  for (const s of SUFFIXES) await unsetRuntimeConfig(e, `MEMRAIN_${s}`);
  await e.query(`DELETE FROM runtime_config WHERE key = 'PATH'`);
  clearEnv();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  clearEnv();
});

describe("key helpers", () => {
  it("accepts both prefixes and maps between them", () => {
    expect(isRuntimeConfigKey("MEMRAIN_SEARCH_MODE")).toBe(true);
    expect(isRuntimeConfigKey("MEMEX_SEARCH_MODE")).toBe(true);
    expect(isRuntimeConfigKey("MEMRAIN_")).toBe(false);
    expect(isRuntimeConfigKey("PATH")).toBe(false);
    expect(canonicalKey("MEMEX_A")).toBe("MEMRAIN_A");
    expect(canonicalKey("MEMRAIN_A")).toBe("MEMRAIN_A");
    expect(legacyKey("MEMRAIN_A")).toBe("MEMEX_A");
    expect(canonicalKey("OTHER_A")).toBe("OTHER_A");
  });
});

describe("applyRuntimeEnvOverlay, both prefixes", () => {
  it("a real MEMEX_X env value beats a MEMRAIN_X row and is never overwritten", async () => {
    const e = storage.engine();
    process.env["MEMEX_RCO_A"] = "a";
    await setRuntimeConfig(e, "MEMRAIN_RCO_A", "b");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).not.toContain("MEMRAIN_RCO_A");
    expect(process.env["MEMEX_RCO_A"]).toBe("a");
    expect(process.env["MEMRAIN_RCO_A"]).toBeUndefined();
  });

  it("env MEMRAIN_X beats env MEMEX_X, which beats both rows", async () => {
    const e = storage.engine();
    await setRuntimeConfig(e, "MEMRAIN_RCO_B", "row-new");
    await putRuntimeConfigRow(e, "MEMEX_RCO_B", "row-old");
    const both = await resolveRuntimeConfig(e, "MEMEX_RCO_B", { MEMRAIN_RCO_B: "c", MEMEX_RCO_B: "a" });
    expect(both).toEqual({ value: "c", source: "env", key: "MEMRAIN_RCO_B" });
    const legacyOnly = await resolveRuntimeConfig(e, "MEMRAIN_RCO_B", { MEMEX_RCO_B: "a" });
    expect(legacyOnly).toEqual({ value: "a", source: "env", key: "MEMEX_RCO_B" });
    const rowsOnly = await resolveRuntimeConfig(e, "MEMEX_RCO_B", {});
    expect(rowsOnly).toEqual({ value: "row-new", source: "runtime_config", key: "MEMRAIN_RCO_B" });
  });

  it("a MEMRAIN_X row beats a MEMEX_X row and is projected under both names", async () => {
    const e = storage.engine();
    await setRuntimeConfig(e, "MEMRAIN_RCO_C", "b");
    await putRuntimeConfigRow(e, "MEMEX_RCO_C", "d");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).toContain("MEMRAIN_RCO_C");
    expect(applied).not.toContain("MEMEX_RCO_C");
    expect(process.env["MEMRAIN_RCO_C"]).toBe("b");
    expect(process.env["MEMEX_RCO_C"]).toBe("b");
  });

  it("a MEMEX_X row alone is applied as MEMRAIN_X and stays visible as MEMEX_X", async () => {
    const e = storage.engine();
    await putRuntimeConfigRow(e, "MEMEX_RCO_D", "d");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).toContain("MEMEX_RCO_D");
    expect(process.env["MEMRAIN_RCO_D"]).toBe("d");
    expect(process.env["MEMEX_RCO_D"]).toBe("d");
  });

  it("an empty MEMEX_X env value blocks both rows", async () => {
    const e = storage.engine();
    process.env["MEMEX_RCO_E"] = "";
    await setRuntimeConfig(e, "MEMRAIN_RCO_E", "b");
    await putRuntimeConfigRow(e, "MEMEX_RCO_E", "d");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied.filter((k) => k.endsWith("_RCO_E"))).toEqual([]);
    expect(process.env["MEMEX_RCO_E"]).toBe("");
    expect(process.env["MEMRAIN_RCO_E"]).toBeUndefined();
  });

  it("re-projects a knob when a caller removed one of the projected names", async () => {
    const e = storage.engine();
    await putRuntimeConfigRow(e, "MEMEX_RCO_F", "one");
    await applyRuntimeEnvOverlay(e);
    delete process.env["MEMEX_RCO_F"];
    await putRuntimeConfigRow(e, "MEMEX_RCO_F", "two");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).toContain("MEMEX_RCO_F");
    expect(process.env["MEMEX_RCO_F"]).toBe("two");
    expect(process.env["MEMRAIN_RCO_F"]).toBe("two");
  });

  it("keeps an intact earlier projection, as a set env var would be kept", async () => {
    const e = storage.engine();
    await putRuntimeConfigRow(e, "MEMEX_RCO_G", "one");
    await applyRuntimeEnvOverlay(e);
    await putRuntimeConfigRow(e, "MEMEX_RCO_G", "two");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).not.toContain("MEMEX_RCO_G");
    expect(process.env["MEMEX_RCO_G"]).toBe("one");
  });

  for (const killSwitch of ["MEMRAIN_NO_DB_CONFIG", "MEMEX_NO_DB_CONFIG"]) {
    it(`${killSwitch}=1 alone skips the overlay`, async () => {
      const e = storage.engine();
      await setRuntimeConfig(e, "MEMRAIN_RCO_A", "db");
      process.env[killSwitch] = "1";
      try {
        expect(await applyRuntimeEnvOverlay(e)).toEqual([]);
        expect(process.env["MEMRAIN_RCO_A"]).toBeUndefined();
        expect(process.env["MEMEX_RCO_A"]).toBeUndefined();
      } finally {
        delete process.env[killSwitch];
      }
    });
  }

  it("never projects a row outside the key alphabet", async () => {
    const e = storage.engine();
    const path = process.env["PATH"];
    await setRuntimeConfig(e, "PATH", "/evil");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).not.toContain("PATH");
    expect(process.env["PATH"]).toBe(path);
  });

  it("skips env-only knobs under either prefix and logs the name", async () => {
    const e = storage.engine();
    const had = { new: process.env["MEMRAIN_MAINTENANCE"], old: process.env["MEMEX_MAINTENANCE"] };
    expect(had).toEqual({ new: undefined, old: undefined });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    try {
      await putRuntimeConfigRow(e, "MEMEX_MAINTENANCE", "1");
      const applied = await applyRuntimeEnvOverlay(e);
      expect(applied).not.toContain("MEMEX_MAINTENANCE");
      await unsetRuntimeConfig(e, "MEMEX_MAINTENANCE");
      await setRuntimeConfig(e, "MEMRAIN_MAINTENANCE", "0");
      expect(await applyRuntimeEnvOverlay(e)).not.toContain("MEMRAIN_MAINTENANCE");
    } finally {
      console.error = orig;
    }
    expect(process.env["MEMRAIN_MAINTENANCE"]).toBeUndefined();
    expect(process.env["MEMEX_MAINTENANCE"]).toBeUndefined();
    expect(errs.join("\n")).toContain("MEMEX_MAINTENANCE");
    expect(errs.join("\n")).toContain("MEMRAIN_MAINTENANCE");
    expect(errs.join("\n")).not.toContain("=1");
  });
});


it("reports unavailable config overlays without logging driver text", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const query = spyOn(storage.engine(), "query").mockRejectedValue(Object.assign(new Error("secret DSN and SQL text"), { code: "08006" }));
  try {
    expect(await applyRuntimeEnvOverlay(storage.engine())).toEqual([]);
    expect(runtimeOverlayState(storage.engine())).toBe("unavailable");
    expect(await checkRuntimeConfigOverlay(storage.engine())).toMatchObject({ ok: true, status: "warn" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("08006");
    expect(log.mock.calls[0]![0]).not.toContain("secret");
  } finally { query.mockRestore(); log.mockRestore(); }
  await applyRuntimeEnvOverlay(storage.engine());
  expect(runtimeOverlayState(storage.engine())).toBe("ready");
});

it("keeps missing pre-migration tables quiet", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const query = spyOn(storage.engine(), "query").mockRejectedValue({ code: "42P01" });
  try {
    expect(await applyRuntimeEnvOverlay(storage.engine())).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  } finally { query.mockRestore(); log.mockRestore(); }
});
