/**
 * The operator is told about a paused spend path, and about a paid daemon
 * that cannot run, in doctor and in the advisor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { checkSpendWallet, collectSpendWallet } from "../src/core/spend-notice.ts";
import { resumeSpendPath } from "../src/core/budget.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`spend wallet notices (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let e: Engine;
  beforeEach(async () => {
    db = await open();
    e = db.storage.engine();
  });
  afterEach(async () => { await db.close(); });

  it("doctor is quiet on a brain with no pause, no overrun and no paid daemon on", async () => {
    expect(await checkSpendWallet(e, {})).toEqual({ ok: true, status: "ok", detail: expect.any(String) });
    expect(await collectSpendWallet.collect({ engine: e, version: "x", now: new Date() })).toEqual([]);
  });

  it("doctor and the advisor name a paused path until it is resumed", async () => {
    await e.query(`INSERT INTO spend_path_pauses (path, reason, model, held_cents, actual_cents)
                   VALUES ('connector_sync', 'overrun: test', 'eu.anthropic.claude-haiku-4-5', 2, 20)`);
    await e.query(`INSERT INTO mcp_spend_log (operation, spend_cents, overrun_cents, role) VALUES ('x', 20, 18, 'connector_sync')`);
    const check = await checkSpendWallet(e, {});
    expect(check.status).toBe("warn");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("connector_sync");
    expect(check.detail).toContain("memrain spend resume connector_sync");
    const findings = await collectSpendWallet.collect({ engine: e, version: "x", now: new Date() });
    expect(findings).toEqual([expect.objectContaining({
      id: "spend_path_paused", severity: "high", fix_command: "memrain spend resume connector_sync", collector: "spend-wallet",
    })]);

    await resumeSpendPath(e, "connector_sync", "cli");
    expect(await collectSpendWallet.collect({ engine: e, version: "x", now: new Date() })).toEqual([]);
    // The overrun itself stays visible in doctor for a week.
    expect((await checkSpendWallet(e, {})).detail).toContain("overran");
  });

  it("doctor warns when a paid daemon is switched on but the brain has no daily cap", async () => {
    await e.query(`INSERT INTO daemon_controls (daemon, source_id, enabled) VALUES ('connector_sync', '*', true)`);
    const check = await checkSpendWallet(e, {});
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("MEMRAIN_DAILY_BUDGET_USD");
    expect((await checkSpendWallet(e, { MEMRAIN_DAILY_BUDGET_USD: "10" })).status).toBe("ok");
  });
});
