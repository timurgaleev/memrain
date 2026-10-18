/**
 * Request-log retention against a real Postgres: batches, the boundary row,
 * and rows written while the run is in progress. Plan shape is not asserted:
 * with mostly-qualifying rows a Seq Scan is a fair planner choice. Skipped
 * unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database with pgvector.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { Storage } from "../src/core/storage.ts";
import { BATCH, purgeRequestLog } from "../src/core/request-log-retention.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;
const DAY = 86_400_000;

describe.skipIf(!URL_)("request-log retention on Postgres", () => {
  let pg: PostgresEngine;

  beforeAll(async () => {
    pg = new PostgresEngine({ url: URL_! });
    await new Storage(pg).init();
  });
  afterAll(async () => {
    await pg.query("DELETE FROM mcp_request_log");
    await pg.close();
  });

  const count = async (where = "TRUE") =>
    Number((await pg.query<{ n: string }>(`SELECT count(*)::text AS n FROM mcp_request_log WHERE ${where}`)).rows[0]?.n);

  it("deletes old rows in batches, keeps the boundary row and rows written during the run", async () => {
    await pg.query("DELETE FROM mcp_request_log");
    const now = new Date();
    const old = new Date(now.getTime() - 200 * DAY).toISOString();
    const boundary = new Date(now.getTime() - 180 * DAY + 60_000).toISOString();
    await pg.query(
      `INSERT INTO mcp_request_log (agent_name, operation, created_at)
       SELECT 'old', 'page_get', $1::timestamptz FROM generate_series(1, $2::int)`,
      [old, 2 * BATCH + 3],
    );
    await pg.query(`INSERT INTO mcp_request_log (agent_name, operation, created_at) VALUES ('boundary', 'page_get', $1)`, [boundary]);

    let fences = 0;
    const r = await purgeRequestLog(pg, {
      days: 180,
      now,
      between: async () => {
        fences++;
        await pg.query(`INSERT INTO mcp_request_log (agent_name, operation) VALUES ('during', 'search')`);
      },
    });

    expect(r).toEqual({ deleted: 2 * BATCH + 3, capped: false });
    expect(fences).toBe(2);
    expect(await count("agent_name = 'old'")).toBe(0);
    expect(await count("agent_name = 'boundary'")).toBe(1);
    expect(await count("agent_name = 'during'")).toBe(2);
  });
});
