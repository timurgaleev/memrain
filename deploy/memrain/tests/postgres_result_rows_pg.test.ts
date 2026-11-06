/**
 * A statement that streamed some rows and then failed (division by zero,
 * statement_timeout) must not leave its row count behind on the connection:
 * the next statement would come back with empty slots in front of its rows.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;

describe.skipIf(!URL_)("postgres driver after a query that failed mid-stream", () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine({ url: URL_!, max: 1 });
    await engine.ready();
  });

  afterAll(async () => {
    await engine.close();
  });

  it("a query that streamed rows then failed leaves no phantom rows for the next query", async () => {
    await expect(engine.query(
      `SELECT CASE WHEN g < 5 THEN g ELSE 1/(g-g) END AS v FROM generate_series(1,10) g`,
    )).rejects.toMatchObject({ code: "22012" });
    const r = await engine.query<{ x: number }>(`SELECT 1 AS x`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ x: 1 });
  });
});
