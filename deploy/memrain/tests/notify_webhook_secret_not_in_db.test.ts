import { describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";
import { applyRuntimeEnvOverlay, setRuntimeConfig } from "../src/core/runtime-config.ts";

// Whoever holds the webhook secret can sign a notification the owner's
// receiver trusts; a copy in runtime_config would hand it to anyone with a
// database dump.
const SECRET = "s".repeat(48);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`notification webhook secret stays out of runtime_config (${name})`, () => {
  it("refuses to store the secret or its file path", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const k of ["MEMRAIN_NOTIFY_WEBHOOK_SECRET", "MEMEX_NOTIFY_WEBHOOK_SECRET", "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE"]) {
        await expect(setRuntimeConfig(e, k, SECRET)).rejects.toThrow("environment");
      }
      const rows = await e.query(`SELECT key FROM runtime_config WHERE key LIKE '%NOTIFY_WEBHOOK_SECRET%'`);
      expect(rows.rows).toEqual([]);
    } finally { await db.close(); }
  });

  it("never projects a stored secret row into the environment", async () => {
    const db = await open();
    const e = db.storage.engine();
    const saved = process.env.MEMRAIN_NOTIFY_WEBHOOK_SECRET;
    delete process.env.MEMRAIN_NOTIFY_WEBHOOK_SECRET;
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await putRuntimeConfigRow(e, "MEMRAIN_NOTIFY_WEBHOOK_SECRET", SECRET);
      const applied = await applyRuntimeEnvOverlay(e);
      expect(applied).not.toContain("MEMRAIN_NOTIFY_WEBHOOK_SECRET");
      expect(process.env.MEMRAIN_NOTIFY_WEBHOOK_SECRET).toBeUndefined();
    } finally {
      err.mockRestore();
      if (saved === undefined) delete process.env.MEMRAIN_NOTIFY_WEBHOOK_SECRET;
      else process.env.MEMRAIN_NOTIFY_WEBHOOK_SECRET = saved;
      await db.close();
    }
  });
});
