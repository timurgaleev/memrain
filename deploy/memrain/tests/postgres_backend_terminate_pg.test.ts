/**
 * The driver must survive a backend that dies under it, the way an RDS failover
 * or an operator's pg_terminate_backend ends a session: the statement on the
 * dead session fails, the pool's next statement runs on a fresh session within
 * a second, and nothing rejects with nobody listening (Bun exits on that).
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import postgres, { type Sql } from "postgres";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;

describe.skipIf(!URL_)("postgres driver after a terminated backend", () => {
  let engine: PostgresEngine;
  let admin: Sql;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    engine = new PostgresEngine({ url: URL_!, max: 2 });
    await engine.ready();
    admin = postgres(URL_!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await engine.close();
    await admin.end({ timeout: 5 });
  });

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  async function terminate(pid: number): Promise<void> {
    const [row] = await admin<{ ok: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS ok`;
    expect(row!.ok).toBe(true);
  }

  async function pidRunning(marker: string): Promise<number> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await admin<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE query LIKE ${`%${marker}%`} AND pid <> pg_backend_pid()`;
      if (rows.length > 0) return rows[0]!.pid;
      await Bun.sleep(20);
    }
    throw new Error(`no backend is running ${marker}`);
  }

  async function nextQueryIsFast(): Promise<void> {
    const started = performance.now();
    const { rows } = await engine.query<{ one: number }>("SELECT 1 AS one");
    expect(rows[0]!.one).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  }

  async function settle(): Promise<void> {
    // Give a stray rejection from the closed socket a few turns to surface.
    await Bun.sleep(100);
    expect(unhandled).toEqual([]);
  }

  it("a statement whose backend is terminated mid-flight fails, and the pool recovers at once", async () => {
    const marker = `terminate-inflight-${crypto.randomUUID()}`;
    const inflight = engine.query(`SELECT pg_sleep(10) /* ${marker} */`);
    const outcome = inflight.then(() => "resolved", (e: unknown) => e);
    await terminate(await pidRunning(marker));

    const error = await outcome;
    expect(error).not.toBe("resolved");
    expect(String((error as { code?: string }).code)).toMatch(/57P01|CONNECTION_CLOSED/);

    await nextQueryIsFast();
    await settle();
  });

  it("a transaction whose backend is terminated rejects, and its connection is not reused", async () => {
    let killedPid = 0;
    const outcome = engine
      .transaction(async (tx) => {
        const { rows } = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        killedPid = rows[0]!.pid;
        await terminate(killedPid);
        await tx.query("SELECT 1");
        return "committed";
      })
      .then((v) => v, (e: unknown) => e);

    const error = await outcome;
    expect(error).not.toBe("committed");
    expect(String((error as { code?: string }).code)).toMatch(/57P01|CONNECTION_CLOSED/);

    await nextQueryIsFast();
    const pids = await Promise.all([
      engine.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      engine.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
    ]);
    for (const { rows } of pids) expect(rows[0]!.pid).not.toBe(killedPid);
    await settle();
  });

  it("a reserved connection released inside an open transaction is terminated, not pooled", async () => {
    const poisoned: string[] = [];
    const sql = postgres(URL_!, { max: 1, onnotice: () => {}, onpoisoned: (status) => poisoned.push(status) });
    try {
      const reserved = await sql.reserve();
      const [held] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await reserved`BEGIN`;
      reserved.release();

      const started = performance.now();
      const [after] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(after!.pid).not.toBe(held!.pid);
      expect(poisoned).toEqual(["T"]);
      // The session left in the open transaction is gone, not parked idle in transaction.
      await Bun.sleep(100);
      const lingering = await admin`SELECT 1 FROM pg_stat_activity WHERE pid = ${held!.pid}`;
      expect(lingering.length).toBe(0);
      await settle();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
