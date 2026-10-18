/**
 * Retention for mcp_request_log: the purge phase deletes rows older than
 * MEMRAIN_REQUEST_LOG_RETENTION_DAYS (default 180) in bounded, fenced batches.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  BATCH,
  MAX_BATCHES_PER_RUN,
  purgeRequestLog,
  requestLogRetentionDays,
} from "../src/core/request-log-retention.ts";
import { purgePhase } from "../src/core/cycle/purge.ts";
import { PhaseStoppedError, runInPhaseContext } from "../src/core/cycle/phase-context.ts";
import { onboardingSteps } from "../src/core/admin-onboarding.ts";

const ENV = "MEMRAIN_REQUEST_LOG_RETENTION_DAYS";
const DAY = 86_400_000;
const NOW = new Date("2026-10-18T12:00:00Z");

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-reqlog-retention-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env[ENV];
});

async function insertAt(at: Date, n = 1, operation = "page_get"): Promise<void> {
  await engine.query(
    `INSERT INTO mcp_request_log (agent_name, operation, status, created_at)
     SELECT 'agent-1', $2, 'success', $1::timestamptz FROM generate_series(1, $3::int)`,
    [at.toISOString(), operation, n],
  );
}

async function count(): Promise<number> {
  const r = await engine.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_request_log");
  return r.rows[0]?.n ?? 0;
}

describe("purgeRequestLog", () => {
  it("deletes only rows older than the window and leaves the boundary row", async () => {
    await insertAt(new Date(NOW.getTime() - 181 * DAY), 3);
    await insertAt(new Date(NOW.getTime() - 180 * DAY + 60_000));
    await insertAt(new Date(NOW.getTime() - 1 * DAY), 2);
    const r = await purgeRequestLog(engine, { days: 180, now: NOW });
    expect(r).toEqual({ deleted: 3, capped: false });
    expect(await count()).toBe(3);
  });

  it("BATCH+1 old rows take two batches and one fence call between them", async () => {
    await insertAt(new Date(NOW.getTime() - 200 * DAY), BATCH + 1);
    let fences = 0;
    const r = await purgeRequestLog(engine, {
      days: 180,
      now: NOW,
      between: async () => {
        fences++;
      },
    });
    expect(r).toEqual({ deleted: BATCH + 1, capped: false });
    expect(fences).toBe(1);
    expect(await count()).toBe(0);
  });

  it("stops after MAX_BATCHES_PER_RUN full batches and reports capped", async () => {
    let calls = 0;
    const fake = {
      query: async () => {
        calls++;
        return { rows: [{ n: String(BATCH) }] };
      },
    } as unknown as Engine;
    const r = await purgeRequestLog(fake, { days: 180, now: NOW });
    expect(r).toEqual({ deleted: BATCH * MAX_BATCHES_PER_RUN, capped: true });
    expect(calls).toBe(MAX_BATCHES_PER_RUN);
  });

  it("a huge window from the env keeps rows instead of failing the run", async () => {
    await insertAt(new Date(NOW.getTime() - 4000 * DAY));
    process.env[ENV] = "100000000";
    expect(await purgeRequestLog(engine, { now: NOW })).toEqual({ deleted: 0, capped: false });
    expect(await count()).toBe(1);
  });

  it("days=null deletes nothing", async () => {
    await insertAt(new Date(NOW.getTime() - 400 * DAY), 2);
    const r = await purgeRequestLog(engine, { days: null, now: NOW });
    expect(r).toEqual({ deleted: 0, capped: false });
    expect(await count()).toBe(2);
  });

  it("reads the window from the env when days is not passed", async () => {
    await insertAt(new Date(NOW.getTime() - 40 * DAY));
    await insertAt(new Date(NOW.getTime() - 10 * DAY));
    process.env[ENV] = "30";
    expect(await purgeRequestLog(engine, { now: NOW })).toEqual({ deleted: 1, capped: false });
    process.env[ENV] = "0";
    await insertAt(new Date(NOW.getTime() - 4000 * DAY));
    expect(await purgeRequestLog(engine, { now: NOW })).toEqual({ deleted: 0, capped: false });
    expect(await count()).toBe(2);
  });
});

describe("requestLogRetentionDays", () => {
  it("unset → 180, '0' → null, '3' → 7 (clamped), '-5' → 180, 'abc' → 180", () => {
    const cases: Array<[string | undefined, number | null]> = [
      [undefined, 180],
      ["", 180],
      ["0", null],
      ["3", 7],
      ["1", 7],
      ["7", 7],
      ["365", 365],
      [" 90 ", 90],
      ["-5", 180],
      ["abc", 180],
      ["1.5", 180],
      ["30d", 180],
      ["36500", 36500],
      ["999999", 36500],
      ["1e9", 180],
    ];
    for (const [raw, want] of cases) {
      if (raw === undefined) delete process.env[ENV];
      else process.env[ENV] = raw;
      expect([raw, requestLogRetentionDays()]).toEqual([raw, want]);
    }
  });

  it("warns once per process for a clamped value, not on every read", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env[ENV] = "5";
      requestLogRetentionDays();
      requestLogRetentionDays();
      const hits = spy.mock.calls.filter((c) => String(c[0]).includes(ENV) && String(c[0]).includes('"5"'));
      expect(hits).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("purge phase retention step", () => {
  it("purgePhase reports purged_request_log", async () => {
    await insertAt(new Date(Date.now() - 200 * DAY), 2);
    await insertAt(new Date(Date.now() - DAY));
    const res = await purgePhase(engine, { ttlHours: 99999 });
    expect(res.purged_request_log).toBe(2);
    expect(res.request_log_capped).toBe(false);
    expect(res.errors).toEqual([]);
    expect(await count()).toBe(1);
  });

  it("a fence stop propagates out of purgePhase instead of becoming an item error", async () => {
    await insertAt(new Date(Date.now() - 200 * DAY), BATCH + 1);
    // The lock is "ours" until the first retention batch has run.
    const fence = async () => (await count()) === BATCH + 1;
    const run = runInPhaseContext({ phase: "purge", signal: new AbortController().signal, fence }, () =>
      purgePhase(engine, { ttlHours: 99999 }),
    );
    await expect(run).rejects.toBeInstanceOf(PhaseStoppedError);
    expect(await count()).toBe(1);
  });

  it("a SQL failure in retention lands in errors[] and the other purge counts still return", async () => {
    await engine.query("DROP TABLE mcp_request_log");
    const res = await purgePhase(engine, { ttlHours: 99999 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith("request_log: ");
    expect(res.purged_request_log).toBe(0);
    expect(res.purged_documents_deleted).toBe(0);
    expect(res.purged_pages).toBe(0);
  });
});

describe("onboarding after retention", () => {
  it("keeps agent_connected and first_search done once the agent rows age out", async () => {
    const tokenUsed = new Date(Date.now() - 250 * DAY);
    await engine.query(`INSERT INTO access_tokens (name, token_hash, last_used_at) VALUES ('laptop', 'h1', $1)`, [
      tokenUsed.toISOString(),
    ]);
    await engine.query(
      `INSERT INTO search_telemetry (date, mode, intent, count) VALUES ($1, 'hybrid', 'general', 1)`,
      [tokenUsed.toISOString().slice(0, 10)],
    );
    await insertAt(new Date(Date.now() - 200 * DAY), 1, "search");
    expect((await onboardingSteps(engine)).first_search.source).toBe("agent");

    await purgeRequestLog(engine, { days: 180 });
    expect(await count()).toBe(0);
    const steps = await onboardingSteps(engine);
    expect(steps.agent_connected).toEqual({ done: true, last_seen: tokenUsed.toISOString() });
    expect(steps.first_search).toEqual({ done: true, source: "any" });
  });
});
