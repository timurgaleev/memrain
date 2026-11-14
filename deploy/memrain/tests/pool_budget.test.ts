/**
 * Connection budget. With MEMRAIN_PG_POOL_RESERVE on, long holders (cycle,
 * embed backfill, contextual re-embed) share at most pool-max − 1 slots, so one
 * connection always stays free for /health, job claims and lock renewals.
 * MEMRAIN_SEARCH_MAX_CONCURRENT bounds concurrent searches. Both are off by
 * default. The Postgres half proves the reserve on a real pool of two.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  applicationName,
  connectionBudgetVerdict,
  checkConnectionBudget,
  longHoldSlots,
  withLongHold,
  withSearchSlot,
} from "../src/core/pool-budget.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { makeEngine } from "../src/core/engine/factory.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);

const ENV = ["MEMRAIN_PG_POOL_RESERVE", "MEMRAIN_PG_POOL_MAX", "MEMRAIN_SEARCH_MAX_CONCURRENT", "MEMRAIN_PG_APPLICATION_NAME"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

async function peakConcurrency(n: number, run: (fn: () => Promise<void>) => Promise<void>): Promise<number> {
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: n }, () => run(async () => {
    active++;
    peak = Math.max(peak, active);
    await tick(20);
    active--;
  })));
  return peak;
}

describe("long-hold budget", () => {
  it("leaves one slot for everything else", () => {
    expect(longHoldSlots(10)).toBe(9);
    expect(longHoldSlots(2)).toBe(1);
    expect(longHoldSlots(1)).toBe(1);
  });

  it("does not limit anything while the reserve is off", async () => {
    process.env["MEMRAIN_PG_POOL_MAX"] = "3";
    expect(await peakConcurrency(5, withLongHold)).toBe(5);
  });

  it("caps concurrent long holders at pool-max − 1 when on", async () => {
    process.env["MEMRAIN_PG_POOL_RESERVE"] = "1";
    process.env["MEMRAIN_PG_POOL_MAX"] = "3";
    expect(await peakConcurrency(6, withLongHold)).toBe(2);
  });

  it("lets a long holder nest another without deadlocking", async () => {
    process.env["MEMRAIN_PG_POOL_RESERVE"] = "1";
    process.env["MEMRAIN_PG_POOL_MAX"] = "2";
    const out = await withLongHold(() => withLongHold(async () => "inner"));
    expect(out).toBe("inner");
  });

  it("releases its slot when the work throws", async () => {
    process.env["MEMRAIN_PG_POOL_RESERVE"] = "1";
    process.env["MEMRAIN_PG_POOL_MAX"] = "2";
    await expect(withLongHold(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withLongHold(async () => "next")).toBe("next");
  });
});

describe("search concurrency", () => {
  it("is unbounded when unset or malformed", async () => {
    expect(await peakConcurrency(4, withSearchSlot)).toBe(4);
    process.env["MEMRAIN_SEARCH_MAX_CONCURRENT"] = "abc";
    expect(await peakConcurrency(4, withSearchSlot)).toBe(4);
  });

  it("bounds concurrent searches when set", async () => {
    process.env["MEMRAIN_SEARCH_MAX_CONCURRENT"] = "2";
    expect(await peakConcurrency(6, withSearchSlot)).toBe(2);
  });
});

describe("application_name", () => {
  it("is unset by default and sanitised when configured", () => {
    expect(applicationName()).toBeUndefined();
    process.env["MEMRAIN_PG_APPLICATION_NAME"] = "memrain:acme:serve";
    expect(applicationName()).toBe("memrain:acme:serve");
    process.env["MEMRAIN_PG_APPLICATION_NAME"] = "memrain:a b;DROP\n";
    expect(applicationName()).toBe("memrain:abDROP");
    process.env["MEMRAIN_PG_APPLICATION_NAME"] = "x".repeat(100);
    expect(applicationName()!.length).toBe(63);
  });
});

describe("doctor db-connection-budget", () => {
  it("warns when the planned pools pass 80% of usable connections", () => {
    expect(connectionBudgetVerdict({ maxConnections: 100, reserved: 3, poolMax: 10, processes: 2, inUse: 12 }).status).toBe("ok");
    const planned = connectionBudgetVerdict({ maxConnections: 100, reserved: 3, poolMax: 40, processes: 2, inUse: 12 });
    expect(planned.status).toBe("warn");
    expect(planned.detail).toContain("80");
    const busy = connectionBudgetVerdict({ maxConnections: 100, reserved: 3, poolMax: 10, processes: 1, inUse: 90 });
    expect(busy.status).toBe("warn");
  });

  it("does not apply to PGLite", async () => {
    const [pglite] = storageEngines(undefined);
    const { storage, close } = await pglite!.open();
    try {
      const c = await checkConnectionBudget(storage.engine());
      expect(c).toMatchObject({ name: "db-connection-budget", ok: true, status: "ok" });
    } finally {
      await close();
    }
  });
});

const PG = process.env["MEMRAIN_TEST_POSTGRES_URL"];
if (PG) {
  describe("Postgres pool of two", () => {
    // Two long transactions, then a health probe; returns how long the probe waited.
    async function probeWhileBusy(engine: PostgresEngine, budgeted: boolean): Promise<number> {
      const hold = () => engine.transaction(async tx => { await tx.query("SELECT pg_sleep(1.5)"); });
      const run = budgeted ? () => withLongHold(hold) : hold;
      const holders = [run(), run()];
      await tick(200);
      const t0 = performance.now();
      await engine.query("SELECT 1");
      const waited = performance.now() - t0;
      await Promise.all(holders);
      return waited;
    }

    it("control: without the reserve two long holders starve the health probe", async () => {
      const engine = new PostgresEngine({ url: PG, max: 2 });
      try {
        expect(await probeWhileBusy(engine, false)).toBeGreaterThan(1000);
      } finally {
        await engine.close();
      }
    });

    it("with the reserve the health probe gets the spare connection", async () => {
      process.env["MEMRAIN_PG_POOL_RESERVE"] = "1";
      process.env["MEMRAIN_PG_POOL_MAX"] = "2";
      const engine = new PostgresEngine({ url: PG, max: 2 });
      try {
        expect(await probeWhileBusy(engine, true)).toBeLessThan(1000);
      } finally {
        await engine.close();
      }
    });

    it("tags the connection with the configured application_name", async () => {
      process.env["MEMRAIN_PG_APPLICATION_NAME"] = "memrain:test:serve";
      const engine = makeEngine({ database: { type: "postgres", url: PG } } as Parameters<typeof makeEngine>[0]);
      try {
        const r = await engine.query<{ name: string }>("SELECT current_setting('application_name') AS name");
        expect(r.rows[0]?.name).toBe("memrain:test:serve");
      } finally {
        await engine.close();
      }
    });

    it("reads the server's connection limits for the doctor", async () => {
      const engine = new PostgresEngine({ url: PG, max: 2 });
      try {
        const c = await checkConnectionBudget(engine);
        expect(c.name).toBe("db-connection-budget");
        expect(["ok", "warn"]).toContain(c.status);
        expect(c.detail).toMatch(/max_connections/);
      } finally {
        await engine.close();
      }
    });
  });
}
