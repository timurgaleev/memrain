/**
 * The spend report rolls the ledger up by model, feature and spender, and
 * names the calls its totals cannot see.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { spendReport } from "../src/core/spend-report.ts";

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-report-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function row(op: string, model: string, client: string | null, cents: number | null, tokens: number | null, ageDays = 0) {
  await storage.engine().query(
    `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
    [client, op, cents, model, tokens, tokens === null ? null : 0, String(ageDays)],
  );
}

describe("spendReport", () => {
  it("groups the window by model, feature and spender", async () => {
    await row("embedding", "titan", null, 10, 100);
    await row("embedding", "titan", "alice", 30, 300);
    await row("think", "sonnet", "alice", 200, 1000);
    await row("think", "sonnet", "alice", 999, 1000, 30); // outside the window
    const r = await spendReport(storage.engine(), { days: 7 });
    expect(r.calls).toBe(3);
    expect(r.total_usd).toBeCloseTo(2.4, 9);
    expect(r.by_model.map((g) => [g.key, g.calls, g.usd])).toEqual([
      ["sonnet", 1, 2],
      ["titan", 2, 0.4],
    ]);
    expect(r.by_operation[0]).toMatchObject({ key: "think", input_tokens: 1000 });
    expect(r.by_client.map((g) => g.key)).toEqual(["alice", null]);
  });

  it("names what the totals cannot see", async () => {
    await row("think", "unpriced-model", "bob", null, 50);
    await row("think", "sonnet", "bob", 0, null);
    await row("think", "sonnet", "bob", 40, null); // booked before tokens were kept
    const r = await spendReport(storage.engine(), { days: 1 });
    expect(r.coverage).toEqual({
      unpriced_calls: 1,
      unpriced_models: ["unpriced-model"],
      no_usage_calls: 1,
      tokens_unrecorded_calls: 1,
    });
    expect(r.total_usd).toBeCloseTo(0.4, 9);
  });

  it("groups by phase and job, names outcomes, and keeps refusals out of the calls", async () => {
    const q = (sql: string) => storage.engine().query(sql);
    await q(`INSERT INTO mcp_spend_log (operation, spend_cents, model, phase, job_id, outcome, latency_ms)
             VALUES ('concepts', 30, 'haiku', 'concepts', NULL, 'ok', 100),
                    ('concepts', 10, 'haiku', 'concepts', NULL, 'ok', 300),
                    ('extract', 50, 'sonnet', NULL, 'job-1', 'error', 1000),
                    ('extract', 0, 'sonnet', NULL, 'job-1', 'refused', NULL),
                    ('think', 5, 'haiku', NULL, NULL, NULL, NULL)`);
    const r = await spendReport(storage.engine(), { days: 1 });
    expect(r.calls).toBe(4);
    expect(r.by_phase.map((g) => [g.key, g.calls, g.usd])).toEqual([
      [null, 2, 0.55],
      ["concepts", 2, 0.4],
    ]);
    expect(r.by_job.map((g) => [g.key, g.calls])).toEqual([
      ["job-1", 1],
      [null, 3],
    ]);
    expect(Object.fromEntries(r.outcomes.map((g) => [String(g.key), g.calls]))).toEqual({
      ok: 2,
      error: 1,
      refused: 1,
      null: 1,
    });
    expect(r.coverage.no_usage_calls).toBe(0);
    const concepts = r.latency.find((l) => l.operation === "concepts")!;
    expect(concepts).toMatchObject({ calls: 2, p50_ms: 200 });
    expect(concepts.p95_ms).toBeCloseTo(290, 6);
    expect(r.latency.map((l) => l.operation)).toEqual(["extract", "concepts"]);
  });

  it("shows today against the daily caps", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "2";
    process.env.MEMRAIN_CYCLE_MAX_USD_PER_DAY = "0.5";
    try {
      await storage.engine().query(
        `INSERT INTO mcp_spend_log (operation, spend_cents, phase) VALUES ('a', 40, 'concepts'), ('b', 60, NULL)`,
      );
      const r = await spendReport(storage.engine(), { days: 1 });
      expect(r.today.brain_usd).toBeCloseTo(1, 9);
      expect(r.today.cycle_usd).toBeCloseTo(0.4, 9);
      expect(r.today.brain_cap_usd).toBe(2);
      expect(r.today.cycle_cap_usd).toBe(0.5);
    } finally {
      delete process.env.MEMRAIN_DAILY_BUDGET_USD;
      delete process.env.MEMRAIN_CYCLE_MAX_USD_PER_DAY;
    }
  });

  it("refuses a window it cannot mean", async () => {
    await expect(spendReport(storage.engine(), { days: 0 })).rejects.toThrow("days");
    await expect(spendReport(storage.engine(), { days: 1.5 })).rejects.toThrow("days");
  });
});
