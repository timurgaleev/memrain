/**
 * Worker shutdown drain: stop() lets a running job finish inside the drain
 * window; one that outlasts it is aborted and handed back to `pending` with
 * its retry and stall budgets untouched, and the worker lock is released.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import {
  _resetHandlersForTesting,
  registerHandler,
} from "../src/core/jobs/handlers.ts";

const LOCK_ID = "shutdown-test-lock";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-jobshutdown-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function newWorker(drainMs: number): Worker {
  return new Worker(queue, {
    intervalMs: 10,
    drainMs,
    engine: storage.engine(),
    workerLockId: LOCK_ID,
    logger: () => {},
  });
}

/** Register `kind` with a handler that signals entry, then runs `body`. */
function handlerThatSignals(
  kind: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<void> {
  return new Promise((entered) => {
    registerHandler(kind, async () => {
      entered();
      return body();
    });
  });
}

async function lockRows(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM worker_lock WHERE id = $1`,
    [LOCK_ID],
  );
  return r.rows[0]?.n ?? 0;
}

describe("worker shutdown drain", () => {
  it("hands back a job that outlasts the drain window, budgets untouched", async () => {
    const entered = handlerThatSignals("wedge", () => new Promise(() => {}));
    await queue.enqueue({ kind: "wedge", id: "w", maxRetries: 3 });
    const worker = newWorker(100);
    worker.start();
    await entered;
    expect(await lockRows()).toBe(1);

    const t0 = Date.now();
    await worker.stop();
    expect(Date.now() - t0).toBeLessThan(2000);

    const row = await queue.get("w");
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBe("worker_shutdown");
    expect(row?.retryCount).toBe(0);
    expect(row?.stallCount).toBe(0);
    expect(row?.lockUntil).toBeNull();
    expect(row?.claimGeneration).toBe(1);
    expect(await lockRows()).toBe(0);
    const stats = worker.getStats();
    expect(stats.failed).toBe(0);
    expect(stats.retried).toBe(0);

    // Due at once for the next worker.
    const next = await queue.claim();
    expect(next?.id).toBe("w");
    expect(next?.claimGeneration).toBe(2);
  });

  it("lets a job that finishes inside the drain window complete normally", async () => {
    const entered = handlerThatSignals(
      "quick",
      () => new Promise((r) => setTimeout(r, 100, { done: true })),
    );
    await queue.enqueue({ kind: "quick", id: "q" });
    const worker = newWorker(5000);
    worker.start();
    await entered;
    await worker.stop();

    const row = await queue.get("q");
    expect(row?.status).toBe("succeeded");
    expect(row?.result).toEqual({ done: true });
    expect(row?.lastError).toBeNull();
    expect(worker.getStats().succeeded).toBe(1);
    expect(await lockRows()).toBe(0);
  });
});

describe("worker shutdown during a claim", () => {
  it("waits for an in-flight claim instead of starting the job after stop()", async () => {
    let ran = 0;
    registerHandler("late", async () => {
      ran++;
      return { done: true };
    });
    await queue.enqueue({ kind: "late", id: "l" });
    let claimEntered!: () => void;
    const claimStarted = new Promise<void>((r) => (claimEntered = r));
    const realClaim = queue.claim.bind(queue);
    queue.claim = async (opts) => {
      claimEntered();
      await new Promise((r) => setTimeout(r, 200));
      return realClaim(opts);
    };
    const worker = newWorker(5000);
    worker.start();
    await claimStarted;
    await worker.stop();

    // The job either ran to completion inside stop() or was never started;
    // it must not begin after stop() has returned.
    const ranAtStop = ran;
    // Longer than the delayed claim, so a late start would have happened.
    await new Promise((r) => setTimeout(r, 400));
    expect(ran).toBe(ranAtStop);
    expect((await queue.get("l"))?.status).not.toBe("running");
    expect(await lockRows()).toBe(0);
  });
});

describe("releaseForShutdown", () => {
  it("does not touch a row claimed by a newer generation", async () => {
    await queue.enqueue({ kind: "x", id: "s" });
    await queue.claim();
    const later = new Date(Date.now() + 10 * 60_000);
    await queue.handleStalled({ now: later });
    const second = await queue.claim({ now: later });
    expect(second?.claimGeneration).toBe(2);

    expect(await queue.releaseForShutdown("s", 1)).toBe(false);
    const row = await queue.get("s");
    expect(row?.status).toBe("running");
    expect(row?.claimGeneration).toBe(2);
    expect(row?.lastError).not.toBe("worker_shutdown");
    expect(row?.lockUntil).not.toBeNull();
  });
});
