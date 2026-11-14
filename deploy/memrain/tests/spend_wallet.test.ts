/**
 * The spend wallet: hierarchical caps over the existing ledger and holds.
 *
 * Locks, on both engines (Postgres races on real connections):
 *   - racing calls never hold past a path, daemon or daemon-source day cap,
 *     nor past an in-process run cap;
 *   - a call whose provider reports more than its hold (an estimate error)
 *     books the full actual, counts only the hold against every cap, pauses
 *     its path and is followed by refusals until the operator resumes it;
 *   - a per-call cap, an unpriced model and an unbounded output refuse before
 *     the provider is reached;
 *   - a new paid path refuses while MEMRAIN_DAILY_BUDGET_USD is unset;
 *   - every row carries the path, daemon and source it was spent under.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  WalletRefusal,
  isBudgetRefusal,
  isDailyCapRefusal,
  pausedSpendPaths,
  resumeSpendPath,
  roleDaySpendUsd,
  runInWallet,
  setSpendLedgerEngine,
  trackedInvoke,
  worstCaseUsd,
  type SpendMeter,
  type WalletPath,
} from "../src/core/budget.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
/** Worst case $0.02 at Haiku's $5/1M output rate (13 tokens of empty-input framing). */
const TWO_CENTS = { operation: "wallet-test", model: HAIKU, worstCase: { input: "", maxOutputTokens: 4_000 - 13 } };
const ENV = ["MEMRAIN_DAILY_BUDGET_USD", "MEMRAIN_CYCLE_MAX_USD_PER_DAY"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reports a usage worth exactly the hold, after a pause so racing calls overlap. */
async function billWorst(m: SpendMeter): Promise<string> {
  await sleep(15);
  m.report({ inputTokens: 64, outputTokens: 4_000 - 13 });
  return "ok";
}

async function race(path: WalletPath, n: number): Promise<{ ok: number; refused: number }> {
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => runInWallet(path, () => trackedInvoke(TWO_CENTS, billWorst))),
  );
  for (const r of results) {
    if (r.status === "rejected" && !isBudgetRefusal(r.reason)) throw r.reason;
  }
  return {
    ok: results.filter((r) => r.status === "fulfilled").length,
    refused: results.filter((r) => r.status === "rejected").length,
  };
}

async function heldOrSpentCents(e: Engine, where: string): Promise<number> {
  const r = await e.query<{ c: string | number }>(
    `SELECT COALESCE(SUM(spend_cents - COALESCE(overrun_cents, 0)), 0) AS c FROM mcp_spend_log WHERE ${where}`,
  );
  return Number(r.rows[0]!.c);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`spend wallet (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let e: Engine;

  beforeEach(async () => {
    for (const k of ENV) delete process.env[k];
    db = await open();
    e = db.storage.engine();
    setSpendLedgerEngine(e);
  });
  afterEach(async () => {
    for (const k of ENV) delete process.env[k];
    setSpendLedgerEngine(null);
    await db.close();
  });

  it("racing calls never hold past a path's day cap", async () => {
    const r = await race({ role: "race-role", dayCapUsd: 0.05 }, 8);
    expect(r.ok).toBe(2);
    expect(await heldOrSpentCents(e, `role = 'race-role'`)).toBeLessThanOrEqual(5);
    expect(await roleDaySpendUsd(e, "race-role")).toBeCloseTo(0.04, 4);
  });

  it("racing calls never hold past a daemon's day cap, nor past one source's", async () => {
    const all = await race({ role: "sync", daemon: { name: "d1", sourceId: "a", dayCapUsd: 0.05 } }, 6);
    expect(all.ok).toBe(2);
    const perSource = await race({ role: "sync", daemon: { name: "d2", sourceId: "b", sourceDayCapUsd: 0.03 } }, 6);
    expect(perSource.ok).toBe(1);
    const otherSource = await race({ role: "sync", daemon: { name: "d2", sourceId: "c", sourceDayCapUsd: 0.03 } }, 6);
    expect(otherSource.ok).toBe(1);
    expect(await heldOrSpentCents(e, `daemon = 'd1'`)).toBeLessThanOrEqual(5);
  });

  it("racing calls inside one run never pass its run cap", async () => {
    const results = await runInWallet({ role: "one-run", runCapUsd: 0.05 }, () => Promise.allSettled(
      Array.from({ length: 8 }, () => trackedInvoke(TWO_CENTS, billWorst)),
    ));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refusal = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refusal.reason).toBeInstanceOf(WalletRefusal);
    expect((refusal.reason as WalletRefusal).scope).toBe("run");
  });

  it("an underestimated call cannot push a capped counter past its cap, and pauses its path", async () => {
    const path: WalletPath = { role: "under", dayCapUsd: 0.05 };
    let sent = 0;
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => {
      sent++;
      // Ten times the hold: the price table or the estimate was wrong.
      m.report({ inputTokens: 0, outputTokens: 40_000 });
    }));
    const row = (await e.query<{ spend_cents: string; overrun_cents: string }>(
      `SELECT spend_cents, overrun_cents FROM mcp_spend_log WHERE role = 'under'`,
    )).rows[0]!;
    expect(Number(row.spend_cents)).toBeCloseTo(20, 2);
    expect(Number(row.overrun_cents)).toBeCloseTo(18, 2);
    expect(await roleDaySpendUsd(e, "under")).toBeCloseTo(0.02, 4);
    expect((await pausedSpendPaths(e)).map((p) => p.path)).toEqual(["under"]);

    const err = await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => {
      sent++;
      m.report({ inputTokens: 0, outputTokens: 1 });
    })).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WalletRefusal);
    expect((err as WalletRefusal).scope).toBe("paused");
    expect(sent).toBe(1);

    expect(await resumeSpendPath(e, "under", "operator")).toBe(true);
    expect(await pausedSpendPaths(e)).toEqual([]);
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, billWorst));
    expect(await roleDaySpendUsd(e, "under")).toBeCloseTo(0.04, 4);
  });

  it("a pause resolved by another process (admin, CLI) lets this process spend again", async () => {
    const path: WalletPath = { role: "elsewhere" };
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => m.report({ inputTokens: 0, outputTokens: 40_000 })));
    expect((await pausedSpendPaths(e)).map((p) => p.path)).toEqual(["elsewhere"]);
    await e.query(`UPDATE spend_path_pauses SET resolved_at = NOW(), resolved_by = 'other-process'`);
    let sent = 0;
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => { sent++; await billWorst(m); }));
    expect(sent).toBe(1);
  });

  it("an enclosing path's day cap counts the spend of the paths nested in it", async () => {
    await runInWallet({ role: "outer-day", dayCapUsd: 0.05 }, () =>
      runInWallet({ role: "inner-a" }, () => trackedInvoke(TWO_CENTS, billWorst)));
    await runInWallet({ role: "outer-day", dayCapUsd: 0.05 }, () =>
      runInWallet({ role: "inner-b" }, () => trackedInvoke(TWO_CENTS, billWorst)));
    const err = await runInWallet({ role: "outer-day", dayCapUsd: 0.05 }, () =>
      runInWallet({ role: "inner-c" }, () => trackedInvoke(TWO_CENTS, billWorst))).catch((x: unknown) => x);
    expect((err as { scope: string }).scope).toBe("role");
    expect(await roleDaySpendUsd(e, "outer-day")).toBeCloseTo(0.04, 4);
    expect(await roleDaySpendUsd(e, "inner-a")).toBeCloseTo(0.02, 4);
  });

  it("a pause whose write failed is kept and written on the path's next call", async () => {
    let failPauseWrite = true;
    const flaky = new Proxy(e, {
      get(target, prop, recv) {
        if (prop === "query") {
          return (sql: string, params?: unknown[]) => {
            if (failPauseWrite && sql.includes("INSERT INTO spend_path_pauses")) {
              failPauseWrite = false;
              return Promise.reject(new Error("connection reset"));
            }
            return target.query(sql, params);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    setSpendLedgerEngine(flaky);
    const path: WalletPath = { role: "flaky-pause" };
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => m.report({ inputTokens: 0, outputTokens: 40_000 })));
    expect(await pausedSpendPaths(e)).toEqual([]);
    const err = await runInWallet(path, () => trackedInvoke(TWO_CENTS, billWorst)).catch((x: unknown) => x);
    expect((err as WalletRefusal).scope).toBe("paused");
    expect((await pausedSpendPaths(e)).map((p) => p.path)).toEqual(["flaky-pause"]);
    expect(await resumeSpendPath(e, "flaky-pause", "operator")).toBe(true);
  });

  it("an underestimated call inside a run counts only its hold against the run cap", async () => {
    await runInWallet({ role: "run-under", runCapUsd: 0.05 }, async () => {
      await trackedInvoke(TWO_CENTS, async (m) => m.report({ inputTokens: 0, outputTokens: 400_000 }));
      // The path is paused now, so the run cannot spend the rest either.
      const err = await trackedInvoke(TWO_CENTS, billWorst).catch((x: unknown) => x);
      expect((err as WalletRefusal).scope).toBe("paused");
    });
  });

  it("refuses a call whose maximum cost is over the per-call cap, before sending it", async () => {
    let sent = false;
    const err = await runInWallet({ role: "per-call", callCapUsd: 0.01 }, () =>
      trackedInvoke(TWO_CENTS, async () => { sent = true; })).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WalletRefusal);
    expect((err as WalletRefusal).scope).toBe("call");
    expect(sent).toBe(false);
    const refused = await e.query(`SELECT 1 FROM mcp_spend_log WHERE outcome = 'refused' AND role = 'per-call'`);
    expect(refused.rows).toHaveLength(1);
  });

  it("refuses an unpriced model or an unbounded output inside a wallet path even with no cap set", async () => {
    let sent = false;
    const unpriced = await runInWallet({ role: "p" }, () => trackedInvoke(
      { ...TWO_CENTS, model: "some.unknown-model-v1" }, async () => { sent = true; })).catch((x: unknown) => x);
    expect((unpriced as WalletRefusal).scope).toBe("no_pricing");
    const unbounded = { ...TWO_CENTS, worstCase: { input: "", maxOutputTokens: Number.POSITIVE_INFINITY } };
    expect(worstCaseUsd(unbounded)).toBeNull();
    expect(worstCaseUsd({ ...TWO_CENTS, worstCase: { input: "", maxOutputTokens: -1 } })).toBeNull();
    const err = await runInWallet({ role: "p" }, () => trackedInvoke(unbounded, async () => { sent = true; }))
      .catch((x: unknown) => x);
    expect((err as WalletRefusal).scope).toBe("no_pricing");
    expect(sent).toBe(false);
  });

  it("a new paid path refuses while MEMRAIN_DAILY_BUDGET_USD is unset, and runs once it is", async () => {
    const path: WalletPath = { role: "new-path", requiresBrainCap: true };
    let sent = 0;
    const err = await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => { sent++; m.report({ inputTokens: 1, outputTokens: 1 }); }))
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WalletRefusal);
    expect((err as WalletRefusal).scope).toBe("unconfigured");
    expect((err as Error).message).toContain("MEMRAIN_DAILY_BUDGET_USD");
    expect(sent).toBe(0);
    process.env.MEMRAIN_DAILY_BUDGET_USD = "1";
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, async (m) => { sent++; m.report({ inputTokens: 1, outputTokens: 1 }); }));
    expect(sent).toBe(1);
  });

  it("a day cap refusal is a daily-cap refusal the day rollover clears", async () => {
    const path: WalletPath = { role: "full", dayCapUsd: 0.03 };
    await runInWallet(path, () => trackedInvoke(TWO_CENTS, billWorst));
    const err = await runInWallet(path, () => trackedInvoke(TWO_CENTS, billWorst)).catch((x: unknown) => x);
    expect(isDailyCapRefusal(err)).toBe(true);
    expect((err as { scope: string }).scope).toBe("role");
  });

  it("books the path, daemon and source on the ledger row and the hold", async () => {
    await runInWallet({ role: "outer" }, () =>
      runInWallet({ role: "connector_sync", daemon: { name: "connector_sync", sourceId: "src1", dayCapUsd: 1 } }, () =>
        trackedInvoke(TWO_CENTS, billWorst)));
    const log = (await e.query(`SELECT role, daemon, daemon_source FROM mcp_spend_log`)).rows;
    expect(log).toEqual([{ role: "outer/connector_sync", daemon: "connector_sync", daemon_source: "src1" }]);
    const hold = (await e.query(`SELECT role, daemon, daemon_source, status FROM mcp_spend_reservations`)).rows;
    expect(hold).toEqual([{ role: "outer/connector_sync", daemon: "connector_sync", daemon_source: "src1", status: "settled" }]);
  });

  it("an enclosing path's run cap still binds a call made in a nested path", async () => {
    const results = await runInWallet({ role: "outer", runCapUsd: 0.03 }, () =>
      runInWallet({ role: "inner" }, () => Promise.allSettled([
        trackedInvoke(TWO_CENTS, billWorst),
        trackedInvoke(TWO_CENTS, billWorst),
      ])));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
