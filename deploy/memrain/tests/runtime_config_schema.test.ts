import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CONFIG_KEY_TYPES, checkRuntimeConfigValues, validateConfigValue } from "../src/core/runtime-config-schema.ts";
import { listRuntimeConfig, setRuntimeConfig } from "../src/core/runtime-config.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

it("normalizes every flag, rejects invalid known values even with force, and preserves strings", () => {
  for (const [key, type] of Object.entries(CONFIG_KEY_TYPES)) {
    if (type === "flag") {
      expect(validateConfigValue(key, " TRUE ")).toEqual({ ok: true, value: "1" });
      expect(validateConfigValue(key.replace("MEMRAIN_", "MEMEX_"), "off")).toEqual({ ok: true, value: "0" });
      expect(validateConfigValue(key, "maybe", true).ok).toBe(false);
    }
  }
  expect(validateConfigValue("MEMRAIN_PG_POOL_MAX", "0004")).toEqual({ ok: true, value: "4" });
  for (const v of ["", "3.5", "1e3", "NaN", "9007199254740992"]) expect(validateConfigValue("MEMRAIN_PG_POOL_MAX", v).ok).toBe(false);
  expect(validateConfigValue("MEMRAIN_REQUIRE_WRITE_PRECONDITION", "warn")).toEqual({ ok: true, value: "warn" });
  expect(validateConfigValue("MEMRAIN_ANOMALY_SIGMA", "2.5")).toEqual({ ok: true, value: "2.5" });
  expect(validateConfigValue("toString", "x").ok).toBe(false);
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`config values ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("reports unknown, malformed and noncanonical rows without leaking values or rewriting them", async () => {
    const e = db.storage.engine();
    await setRuntimeConfig(e, "MEMRAIN_PRIVATE_FUTURE", "private-secret");
    await setRuntimeConfig(e, "MEMRAIN_GRAPH_SIGNALS", "true");
    await setRuntimeConfig(e, "MEMRAIN_PG_POOL_MAX", "bad-private-value");
    const before = await listRuntimeConfig(e);
    const report = await checkRuntimeConfigValues(e);
    expect(report.status).toBe("warn");
    expect(report.detail).toContain("MEMRAIN_PRIVATE_FUTURE: unknown key");
    expect(report.detail).toContain("MEMRAIN_GRAPH_SIGNALS: noncanonical value");
    expect(report.detail).toContain("MEMRAIN_PG_POOL_MAX: invalid value");
    expect(report.detail).not.toContain("private-secret");
    expect(report.detail).not.toContain("bad-private-value");
    expect(await listRuntimeConfig(e)).toEqual(before);
    await e.exec("DELETE FROM runtime_config");
    expect((await checkRuntimeConfigValues(e)).status).toBe("ok");
  });
});
