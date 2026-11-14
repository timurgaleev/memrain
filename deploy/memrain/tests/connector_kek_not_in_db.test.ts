import { describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";
import { applyRuntimeEnvOverlay, setRuntimeConfig } from "../src/core/runtime-config.ts";

// The connector key seals tokens stored in the same database; a copy of it in
// runtime_config would let a database dump open every credential.
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector key stays out of runtime_config (${name})`, () => {
  it("refuses to store the key or its file path", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const key = randomBytes(32).toString("base64");
      for (const k of ["MEMRAIN_CONNECTOR_KEK", "MEMEX_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE"]) {
        await expect(setRuntimeConfig(e, k, key)).rejects.toThrow("environment");
      }
      const rows = await e.query(`SELECT key FROM runtime_config WHERE key LIKE '%CONNECTOR_KEK%'`);
      expect(rows.rows).toEqual([]);
    } finally { await db.close(); }
  });

  it("never projects a stored key row into the environment", async () => {
    const db = await open();
    const e = db.storage.engine();
    const saved = process.env.MEMRAIN_CONNECTOR_KEK;
    delete process.env.MEMRAIN_CONNECTOR_KEK;
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await putRuntimeConfigRow(e, "MEMRAIN_CONNECTOR_KEK", randomBytes(32).toString("base64"));
      const applied = await applyRuntimeEnvOverlay(e);
      expect(applied).not.toContain("MEMRAIN_CONNECTOR_KEK");
      expect(process.env.MEMRAIN_CONNECTOR_KEK).toBeUndefined();
    } finally {
      err.mockRestore();
      if (saved === undefined) delete process.env.MEMRAIN_CONNECTOR_KEK;
      else process.env.MEMRAIN_CONNECTOR_KEK = saved;
      await db.close();
    }
  });
});
