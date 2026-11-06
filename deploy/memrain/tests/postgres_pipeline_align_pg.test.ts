/**
 * A query the driver cannot build (an undefined parameter, too many
 * parameters) never reaches the socket. Only that query may fail: replies of
 * the queries in flight with it must still reach their own callers, and the
 * open transaction must stay usable on the same session. The driver still
 * rolls the transaction back at the end, as it does for any failed query.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Engine } from "../src/core/engine/interface.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;

describe.skipIf(!URL_)("postgres driver pipeline after a query build error", () => {
  let engine: PostgresEngine;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    engine = new PostgresEngine({ url: URL_!, max: 1 });
    await engine.ready();
  });

  afterAll(async () => {
    await engine.close();
  });

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  // A misaligned pipeline leaves a query waiting for a reply that never comes.
  function within<T>(p: Promise<T>, ms = 2_000): Promise<T | "timed out"> {
    return Promise.race([p, Bun.sleep(ms).then(() => "timed out" as const)]);
  }

  function settle(p: Promise<unknown>, ms = 2_000) {
    return within(p.then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason: String(reason) }),
    ), ms);
  }

  // Same session and same transaction id means the transaction was not aborted or replaced.
  async function session(tx: Engine) {
    return settle(tx.query("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid"));
  }

  async function afterwards() {
    const { rows } = await engine.query<{ one: number }>("SELECT 1 AS one");
    expect(rows).toEqual([{ one: 1 }]);
    await Bun.sleep(100);
    expect(unhandled).toEqual([]);
  }

  it("a query with an undefined parameter in a pipelined transaction rejects only itself", async () => {
    let seen: unknown[] = [];
    const outcome = await settle(engine.transaction(async (tx) => {
      const before = await session(tx);
      const settled = await Promise.all([
        tx.query("SELECT 2 AS y"),
        tx.query("SELECT $1::text AS t", [undefined]),
        tx.query("SELECT 3 AS z"),
      ].map((p) => settle(p)));
      seen = [...settled, before, await session(tx)];
    }), 8_000);

    const [first, bad, third, before, after] = seen;
    expect(first).toEqual({ status: "fulfilled", value: { rows: [{ y: 2 }] } });
    expect(bad).toMatchObject({ status: "rejected", reason: expect.stringMatching(/UNDEFINED_VALUE/) });
    expect(third).toEqual({ status: "fulfilled", value: { rows: [{ z: 3 }] } });
    expect(before).toMatchObject({ status: "fulfilled" });
    expect(after).toEqual(before);
    expect(outcome).toMatchObject({ status: "rejected", reason: expect.stringMatching(/UNDEFINED_VALUE/) });
    await afterwards();
  }, 10_000);

  it("a lone query with an undefined parameter leaves the transaction usable", async () => {
    let seen: unknown[] = [];
    const outcome = await settle(engine.transaction(async (tx) => {
      const before = await session(tx);
      const bad = await settle(tx.query("SELECT $1::text AS t", [undefined]));
      const next = await settle(tx.query("SELECT 4 AS w"));
      seen = [bad, next, before, await session(tx)];
    }), 8_000);

    const [bad, next, before, after] = seen;
    expect(bad).toMatchObject({ status: "rejected", reason: expect.stringMatching(/UNDEFINED_VALUE/) });
    expect(next).toEqual({ status: "fulfilled", value: { rows: [{ w: 4 }] } });
    expect(before).toMatchObject({ status: "fulfilled" });
    expect(after).toEqual(before);
    expect(outcome).toMatchObject({ status: "rejected", reason: expect.stringMatching(/UNDEFINED_VALUE/) });
    await afterwards();
  }, 10_000);
});
