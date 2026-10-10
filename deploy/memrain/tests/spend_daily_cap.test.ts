/**
 * The brain-wide and cycle daily caps at the spend chokepoint.
 *
 * Locks: with no cap configured nothing is held and nothing refused; the brain
 * cap counts every spender and refuses system calls too; the cycle cap counts
 * and binds only calls under a phase; racing calls never book past a cap; an
 * unpriced model is refused under a cap; and an accounting failure lets the
 * call through unheld. The race is run once more on real Postgres connections
 * when MEMRAIN_TEST_POSTGRES_URL is set (PGLite serializes transactions).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { runMigrations } from "../src/core/migrate.ts";
import { openPostgres119, PG_URL } from "./helpers/migration-120.ts";
import {
  BRAIN_SPEND_ID,
  DAILY_CAP_REASON,
  brainDailyCapUsd,
  brainDaySpendUsd,
  cycleDailyCapUsd,
  isBudgetRefusal,
  isDailyCapRefusal,
  runWithSpendClient,
  runWithSpendTags,
  setSpendLedgerEngine,
  trackedInvoke,
  worstCaseUsd,
} from "../src/core/budget.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
/** Worst case $0.02 at Haiku's $5/1M output rate. */
const TWO_CENTS = { operation: "concepts", model: HAIKU, worstCase: { input: "", maxOutputTokens: 4_000 - 13 } };
const ENV = ["MEMRAIN_DAILY_BUDGET_USD", "MEMRAIN_CYCLE_MAX_USD_PER_DAY"] as const;

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "memrain-daily-cap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function spent(usd: number, opts: { client?: string; phase?: string } = {}): Promise<void> {
  await storage.engine().query(
    `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, phase) VALUES ($1, 'seed', $2, 'x', $3)`,
    [opts.client ?? null, usd * 100, opts.phase ?? null],
  );
}

async function holds(): Promise<{ client_id: string; phase: string | null; status: string }[]> {
  const r = await storage.engine().query<{ client_id: string; phase: string | null; status: string }>(
    `SELECT client_id, phase, status FROM mcp_spend_reservations ORDER BY created_at`,
  );
  return r.rows;
}

const ok = (m: { report: (u: { inputTokens: number; outputTokens: number }) => void }) =>
  m.report({ inputTokens: 100, outputTokens: 100 });

describe("with no cap configured", () => {
  it("holds nothing and refuses nothing for a system call", async () => {
    await spent(1_000);
    await runWithSpendTags({ phase: "concepts" }, () => trackedInvoke(TWO_CENTS, async (m) => ok(m)));
    expect(await holds()).toEqual([]);
  });

  it("reads blank, malformed and negative values as no cap", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const v of ["", "  ", "abc", "-1", "NaN"]) {
        expect(brainDailyCapUsd({ MEMRAIN_DAILY_BUDGET_USD: v })).toBeNull();
      }
    } finally {
      console.warn = warn;
    }
    expect(brainDailyCapUsd({ MEMRAIN_DAILY_BUDGET_USD: "0" })).toBe(0);
    expect(brainDailyCapUsd({ MEMRAIN_DAILY_BUDGET_USD: " 1.50 " })).toBe(1.5);
  });
});

describe("the brain-wide cap", () => {
  it("refuses a system call once every spender together has used the day", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "0.05";
    await spent(0.02, { client: "alice" });
    await spent(0.02);
    const err = await trackedInvoke(TWO_CENTS, async (m) => ok(m)).catch((e: unknown) => e);
    expect(isDailyCapRefusal(err)).toBe(true);
    expect(isBudgetRefusal(err)).toBe(true);
    expect((err as Error).message.startsWith(`${DAILY_CAP_REASON}:`)).toBe(true);
    const refused = await storage.engine().query(`SELECT 1 FROM mcp_spend_log WHERE outcome = 'refused'`);
    expect(refused.rows).toHaveLength(1);
  });

  it("holds a system call under the brain key and books it to no client", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "1";
    await runWithSpendTags({ phase: "concepts" }, () => trackedInvoke(TWO_CENTS, async (m) => ok(m)));
    expect(await holds()).toEqual([{ client_id: BRAIN_SPEND_ID, phase: "concepts", status: "settled" }]);
    const log = await storage.engine().query<{ client_id: string | null }>(`SELECT client_id FROM mcp_spend_log`);
    expect(log.rows).toEqual([{ client_id: null }]);
  });

  it("binds an uncapped client too, with one hold under the client's own id", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "0.03";
    await spent(0.02);
    await expect(
      runWithSpendClient({ clientId: "free", capUsd: null }, () => trackedInvoke(TWO_CENTS, async (m) => ok(m))),
    ).rejects.toMatchObject({ code: "budget_exhausted", reason: DAILY_CAP_REASON });
    process.env.MEMRAIN_DAILY_BUDGET_USD = "1";
    await runWithSpendClient({ clientId: "free", capUsd: null }, () => trackedInvoke(TWO_CENTS, async (m) => ok(m)));
    expect(await holds()).toEqual([{ client_id: "free", phase: null, status: "settled" }]);
  });

  it("keeps a client's own cap refusal a client refusal", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "1";
    const err = await runWithSpendClient({ clientId: "broke", capUsd: 0 }, () =>
      trackedInvoke(TWO_CENTS, async (m) => ok(m)),
    ).catch((e: unknown) => e);
    expect(isBudgetRefusal(err)).toBe(true);
    expect(isDailyCapRefusal(err)).toBe(false);
  });

  it("books no more than the cap when calls race", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "0.1";
    expect(worstCaseUsd(TWO_CENTS)).toBeCloseTo(0.02, 3);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => {
        const call = () =>
          trackedInvoke(TWO_CENTS, async (m) => {
            await new Promise((r) => setTimeout(r, 5));
            m.report({ inputTokens: 0, outputTokens: 4_000 - 13 });
          });
        // Half the racers are a client, half the brain itself.
        return i % 2 ? runWithSpendClient({ clientId: "racer", capUsd: null }, call) : call();
      }),
    );
    const passed = results.filter((r) => r.status === "fulfilled").length;
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(20);
    for (const r of results) if (r.status === "rejected") expect(isDailyCapRefusal(r.reason)).toBe(true);
    expect(await brainDaySpendUsd(storage.engine())).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("refuses a model nobody can price", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "100";
    let sent = false;
    const err = await trackedInvoke({ ...TWO_CENTS, model: "some-unpriced-model" }, async () => {
      sent = true;
    }).catch((e: unknown) => e);
    expect(isDailyCapRefusal(err)).toBe(true);
    expect(sent).toBe(false);
  });

  it("still applies the brain cap when the client's cap lookup fails", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "0.03";
    await spent(0.02);
    const real = storage.engine();
    const broken = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string, params?: unknown[]) =>
            sql.includes("FROM oauth_clients WHERE client_id")
              ? Promise.reject(new Error("db hiccup"))
              : real.query(sql, params as never);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Engine;
    setSpendLedgerEngine(broken);
    let sent = false;
    const err = await runWithSpendClient({ clientId: "lookup-fails" }, () =>
      trackedInvoke(TWO_CENTS, async (m) => {
        sent = true;
        ok(m);
      }),
    ).catch((e: unknown) => e);
    expect(sent).toBe(false);
    expect(isDailyCapRefusal(err)).toBe(true);
  });

  it("lets the call through unheld when the accounting query fails", async () => {
    process.env.MEMRAIN_DAILY_BUDGET_USD = "0";
    const real = storage.engine();
    const broken = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "transaction") return () => Promise.reject(new Error("db down"));
        return Reflect.get(target, prop, receiver);
      },
    }) as Engine;
    setSpendLedgerEngine(broken);
    const warn = console.warn;
    console.warn = () => {};
    let sent = false;
    try {
      await trackedInvoke(TWO_CENTS, async (m) => {
        sent = true;
        ok(m);
      });
    } finally {
      console.warn = warn;
    }
    expect(sent).toBe(true);
    expect(await holds()).toEqual([]);
  });
});

describe.skipIf(!PG_URL)("the brain-wide cap on Postgres", () => {
  it("books no more than the cap when calls race on separate connections", async () => {
    const db = (await openPostgres119(PG_URL!)) as Awaited<ReturnType<typeof openPostgres119>> & { url: string };
    await runMigrations(db.engine);
    const pool = new PostgresEngine({ url: db.url, max: 10 });
    try {
      await pool.ready();
      setSpendLedgerEngine(pool);
      process.env.MEMRAIN_DAILY_BUDGET_USD = "0.1";
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => {
          const call = () =>
            trackedInvoke(TWO_CENTS, async (m) => {
              await new Promise((r) => setTimeout(r, 5));
              m.report({ inputTokens: 0, outputTokens: 4_000 - 13 });
            });
          return i % 2 ? runWithSpendClient({ clientId: `racer-${i}`, capUsd: null }, call) : call();
        }),
      );
      const passed = results.filter((r) => r.status === "fulfilled").length;
      expect(passed).toBeGreaterThan(0);
      expect(passed).toBeLessThan(20);
      expect(await brainDaySpendUsd(pool)).toBeLessThanOrEqual(0.1 + 1e-9);
    } finally {
      setSpendLedgerEngine(null);
      await pool.close();
      await db.close();
    }
  });
});

describe("the cycle cap", () => {
  it("applies only under a phase", async () => {
    process.env.MEMRAIN_CYCLE_MAX_USD_PER_DAY = "0.3";
    expect(cycleDailyCapUsd()).toBeNull();
    await runWithSpendTags({ phase: "concepts" }, async () => {
      expect(cycleDailyCapUsd()).toBe(0.3);
    });
  });

  it("counts only phase spend and refuses only phase calls", async () => {
    process.env.MEMRAIN_CYCLE_MAX_USD_PER_DAY = "0.03";
    await spent(5); // outside any phase: not the cycle's
    await spent(0.02, { phase: "patterns" });
    const err = await runWithSpendTags({ phase: "concepts" }, () =>
      trackedInvoke(TWO_CENTS, async (m) => ok(m)),
    ).catch((e: unknown) => e);
    expect(isDailyCapRefusal(err)).toBe(true);
    expect((err as { scope?: string }).scope).toBe("cycle");
    // The same call outside a phase is not the cycle's and goes through.
    await trackedInvoke(TWO_CENTS, async (m) => ok(m));
  });

  it("counts a phase call still in flight", async () => {
    process.env.MEMRAIN_CYCLE_MAX_USD_PER_DAY = "0.03";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runWithSpendTags({ phase: "concepts" }, () =>
      trackedInvoke(TWO_CENTS, async (m) => {
        await gate;
        ok(m);
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const second = await runWithSpendTags({ phase: "reflections" }, () =>
      trackedInvoke(TWO_CENTS, async (m) => ok(m)),
    ).catch((e: unknown) => e);
    release();
    await first;
    expect(isDailyCapRefusal(second)).toBe(true);
  });
});
