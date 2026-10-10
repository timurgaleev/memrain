/**
 * Tests for the durable jobs queue.
 *
 * Covers: enqueue idempotency, atomic claim ordering, complete/fail
 * semantics, exponential backoff scheduling, retry-budget exhaustion,
 * cancel + manual retry, list/stats, quiet-hours filtering, and the
 * Worker dispatch loop with the handler registry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import {
  registerHandler,
  _resetHandlersForTesting,
} from "../src/core/jobs/handlers.ts";
import { backoffMs } from "../src/core/jobs/backoff.ts";
import { inQuietHours } from "../src/core/jobs/quiet-hours.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

/** Fresh store + queue per test, for the describes that touch the database. */
function useQueue(): void {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-jobs-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    queue = new Queue(storage.engine());
    _resetHandlersForTesting();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
}

describe("backoff", () => {
  it("doubles each retry, capped at maxMs", () => {
    expect(backoffMs(0, { baseMs: 100 })).toBe(100);
    expect(backoffMs(1, { baseMs: 100 })).toBe(200);
    expect(backoffMs(3, { baseMs: 100 })).toBe(800);
    expect(backoffMs(20, { baseMs: 100, maxMs: 1000 })).toBe(1000);
  });
  it("clamps negative input to base", () => {
    expect(backoffMs(-5, { baseMs: 50 })).toBe(50);
  });
});

describe("inQuietHours (Europe/Berlin)", () => {
  it("returns true at 06:30 Berlin", () => {
    // 04:30 UTC → 06:30 CEST (summer) or 05:30 CET (winter). Use a
    // mid-summer date so we hit CEST.
    const t = new Date("2026-07-01T04:30:00Z");
    expect(inQuietHours(t)).toBe(true);
  });
  it("returns false at 09:00 Berlin", () => {
    const t = new Date("2026-07-01T07:00:00Z"); // 09:00 CEST
    expect(inQuietHours(t)).toBe(false);
  });
});

describe("Queue.enqueue + get", () => {
  useQueue();
  it("creates a pending job with defaults", async () => {
    const j = await queue.enqueue({ kind: "embed.titan" });
    expect(j.kind).toBe("embed.titan");
    expect(j.status).toBe("pending");
    expect(j.priority).toBe(5);
    expect(j.maxRetries).toBe(3);
    expect(j.payload).toEqual({});
  });

  it("persists payload as a JSON object", async () => {
    const j = await queue.enqueue({
      kind: "reindex.file",
      payload: { path: "/vault/a.md", reason: "manual" },
    });
    const fetched = await queue.get(j.id);
    expect(fetched?.payload).toEqual({ path: "/vault/a.md", reason: "manual" });
  });

  it("is idempotent on duplicate id (returns existing row)", async () => {
    const a = await queue.enqueue({ kind: "x", id: "stable-1" });
    const b = await queue.enqueue({
      kind: "y", // ignored — first write wins
      id: "stable-1",
    });
    expect(b.id).toBe(a.id);
    expect(b.kind).toBe("x");
  });

  it("rejects priority outside 1-10", async () => {
    await expect(queue.enqueue({ kind: "x", priority: 0 })).rejects.toThrow();
    await expect(queue.enqueue({ kind: "x", priority: 11 })).rejects.toThrow();
  });
});

describe("Queue.claim", () => {
  useQueue();
  it("returns null when nothing is due", async () => {
    expect(await queue.claim()).toBeNull();
  });

  it("picks the highest-priority due job first", async () => {
    await queue.enqueue({ kind: "low", id: "lo", priority: 8 });
    await queue.enqueue({ kind: "high", id: "hi", priority: 2 });
    await queue.enqueue({ kind: "mid", id: "md", priority: 5 });
    const first = await queue.claim();
    expect(first?.id).toBe("hi");
    expect(first?.status).toBe("running");
    const second = await queue.claim();
    expect(second?.id).toBe("md");
    const third = await queue.claim();
    expect(third?.id).toBe("lo");
    expect(await queue.claim()).toBeNull();
  });

  it("respects next_attempt_at — future jobs are skipped", async () => {
    const future = new Date(Date.now() + 60_000);
    await queue.enqueue({ kind: "later", id: "L", runAt: future });
    await queue.enqueue({ kind: "now", id: "N" });
    const first = await queue.claim();
    expect(first?.id).toBe("N");
    expect(await queue.claim()).toBeNull();
  });

  it("skips quiet_hours_skip jobs when in quiet hours", async () => {
    // Anchor next_attempt_at in the past so the fixed claim clocks below stay
    // due regardless of the real wall clock (without runAt, next_attempt_at
    // defaults to the real enqueue time — the fixed 2026-07-01 claim dates fall
    // behind it once that date passes, and nothing is claimable).
    const due = new Date("2026-01-01T00:00:00Z");
    await queue.enqueue({ kind: "embed", id: "Q", quietHoursSkip: true, runAt: due });
    await queue.enqueue({ kind: "noop", id: "L", runAt: due });
    // A "now" inside the window — 06:30 Berlin (summer = 04:30 UTC).
    const inside = new Date("2026-07-01T04:30:00Z");
    const claimed = await queue.claim({ now: inside });
    expect(claimed?.id).toBe("L");
    expect(await queue.claim({ now: inside })).toBeNull();
    // Outside the window: we can pick the deferred one.
    const outside = new Date("2026-07-01T10:00:00Z");
    const next = await queue.claim({ now: outside });
    expect(next?.id).toBe("Q");
  });
});

describe("Queue.complete + fail", () => {
  useQueue();
  it("complete persists the result and finished_at", async () => {
    const j = await queue.enqueue({ kind: "x" });
    await queue.claim();
    await queue.complete(j.id, 1, { reembedded: 3 });
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("succeeded");
    expect(fetched?.result).toEqual({ reembedded: 3 });
    expect(fetched?.finishedAt).not.toBeNull();
  });

  it("fail with retries left → re-pending with backoff", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 2 });
    await queue.claim();
    const now = new Date("2026-05-08T12:00:00Z");
    const updated = await queue.fail(j.id, 1, "boom", { baseMs: 1000, now });
    expect(updated?.status).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.lastError).toBe("boom");
    // base * 2^0 = 1000ms — next attempt is now+1s
    expect(updated?.nextAttemptAt.getTime()).toBe(now.getTime() + 1000);
  });

  it("complete is no-op on a cancelled row (status-guarded)", async () => {
    const j = await queue.enqueue({ kind: "x" });
    await queue.claim();
    await queue.cancel(j.id);
    const updated = await queue.complete(j.id, 1, { ignored: true });
    expect(updated).toBeNull();
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("cancelled");
  });

  it("fail is no-op on a cancelled row (status-guarded)", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 5 });
    await queue.claim();
    await queue.cancel(j.id);
    const updated = await queue.fail(j.id, 1, "should-not-apply");
    expect(updated).toBeNull();
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("cancelled");
    expect(fetched?.lastError).toBeNull();
  });

  it("fail past max_retries → terminal failed", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 1 });
    await queue.claim();
    const t0 = new Date("2026-05-08T12:00:00Z");
    await queue.fail(j.id, 1, "first", { baseMs: 10, now: t0 });
    // Advance the clock past the first retry's next_attempt_at so the
    // second claim flips status back to 'running'. Without this, the
    // status-guard on fail() correctly refuses (pending != running).
    const t1 = new Date(t0.getTime() + 100);
    const reclaimed = await queue.claim({ now: t1 });
    expect(reclaimed?.id).toBe(j.id);
    const second = await queue.fail(j.id, 2, "second", { baseMs: 10, now: t1 });
    expect(second?.status).toBe("failed");
    expect(second?.retryCount).toBe(2);
    expect(second?.lastError).toBe("second");
  });
});

describe("Queue.cancel + retry + list + stats", () => {
  useQueue();
  it("cancel only affects pending/running rows", async () => {
    const j = await queue.enqueue({ kind: "x" });
    const ok = await queue.cancel(j.id);
    expect(ok?.status).toBe("cancelled");
    const again = await queue.cancel(j.id);
    expect(again).toBeNull();
  });

  it("retry resets failed → pending", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 0 });
    await queue.claim();
    await queue.fail(j.id, 1, "die");
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("failed");
    const restored = await queue.retry(j.id);
    expect(restored?.status).toBe("pending");
    expect(restored?.lastError).toBeNull();
    expect(restored?.retryCount).toBe(0);
    expect(restored?.stallCount).toBe(0);
  });

  it("retry restores the retry budget — the next fail re-pends, not terminal-fails", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 1 });
    await queue.claim();
    const t0 = new Date("2026-05-08T12:00:00Z");
    await queue.fail(j.id, 1, "first", { baseMs: 10, now: t0 });
    const t1 = new Date(t0.getTime() + 100);
    await queue.claim({ now: t1 });
    const dead = await queue.fail(j.id, 2, "second", { baseMs: 10, now: t1 });
    expect(dead?.status).toBe("failed");
    expect(dead?.retryCount).toBe(2); // budget spent

    const restored = await queue.retry(j.id);
    expect(restored?.retryCount).toBe(0);
    // retry() re-stamps next_attempt_at to NOW(), so re-claim on the real clock.
    const reclaimed = await queue.claim();
    expect(reclaimed?.id).toBe(j.id);
    const again = await queue.fail(j.id, 3, "third", { baseMs: 10 });
    expect(again?.status).toBe("pending");
    expect(again?.retryCount).toBe(1);
  });

  it("retry restores the stall budget — the next stall requeues, not terminal-fails", async () => {
    const j = await queue.enqueue({ kind: "x" });
    // Park the row at its stall budget, then burn one more so it lands in
    // 'failed' the way a real stall-exhausted job does.
    await storage.engine().exec(
      `UPDATE jobs SET stall_count = 5, max_stalled = 5 WHERE id = '${j.id}'`,
    );
    const t0 = new Date(Date.now() + 60_000);
    await queue.claim({ now: t0, lockSeconds: 10 });
    const dead = await queue.handleStalled({ now: new Date(t0.getTime() + 11_000), graceMs: 0 });
    expect(dead.terminallyFailed).toBe(1);
    expect((await queue.get(j.id))?.status).toBe("failed");

    await queue.retry(j.id);
    const t1 = new Date(Date.now() + 120_000);
    await queue.claim({ now: t1, lockSeconds: 10 });
    const after = await queue.handleStalled({ now: new Date(t1.getTime() + 11_000), graceMs: 0 });
    expect(after.requeued).toBe(1);
    expect(after.terminallyFailed).toBe(0);
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("pending");
    expect(fetched?.stallCount).toBe(1);
  });

  it("list filters by status array", async () => {
    await queue.enqueue({ kind: "a", id: "a" });
    const b = await queue.enqueue({ kind: "b", id: "b" });
    await queue.cancel(b.id);
    const pending = await queue.list({ status: "pending" });
    expect(pending.map((r) => r.id)).toEqual(["a"]);
    const both = await queue.list({ status: ["pending", "cancelled"] });
    expect(both.length).toBe(2);
  });

  it("stats counts each status bucket", async () => {
    await queue.enqueue({ kind: "x", id: "1" });
    const c = await queue.enqueue({ kind: "x", id: "2" });
    await queue.cancel(c.id);
    const s = await queue.stats();
    expect(s.pending).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.succeeded).toBe(0);
  });
});

describe("Queue.handleStalled", () => {
  useQueue();
  // Anchor on a real-time-ish "now" so the enqueue's NOW() default for
  // next_attempt_at lies before t0. Adding a buffer of 60s keeps the
  // ordering stable even if the test machine is slow.
  function nowAnchor(): Date {
    return new Date(Date.now() + 60_000);
  }

  it("requeues a running row whose lock_until has passed", async () => {
    const j = await queue.enqueue({ kind: "x", maxRetries: 3 });
    const t0 = nowAnchor();
    await queue.claim({ now: t0, lockSeconds: 10 });
    const t1 = new Date(t0.getTime() + 11_000);
    const r = await queue.handleStalled({ now: t1, graceMs: 0 });
    expect(r.requeued).toBe(1);
    expect(r.terminallyFailed).toBe(0);
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("pending");
    expect(fetched?.stallCount).toBe(1);
    expect(fetched?.lockUntil).toBeNull();
    expect(fetched?.lastError).toContain("stall");
  });

  it("leaves a non-expired claim alone", async () => {
    await queue.enqueue({ kind: "x", id: "j1" });
    const t0 = nowAnchor();
    await queue.claim({ now: t0, lockSeconds: 60 });
    const r = await queue.handleStalled({ now: new Date(t0.getTime() + 5_000) });
    expect(r.requeued).toBe(0);
    expect(r.terminallyFailed).toBe(0);
    const fetched = await queue.get("j1");
    expect(fetched?.status).toBe("running");
  });

  it("terminal-fails after stall_count exceeds max_stalled", async () => {
    const j = await queue.enqueue({ kind: "x" });
    await storage.engine().exec(
      `UPDATE jobs SET stall_count = 5, max_stalled = 5 WHERE id = '${j.id}'`,
    );
    const t0 = nowAnchor();
    await queue.claim({ now: t0, lockSeconds: 10 });
    const t1 = new Date(t0.getTime() + 11_000);
    const r = await queue.handleStalled({ now: t1, graceMs: 0 });
    expect(r.terminallyFailed).toBe(1);
    expect(r.requeued).toBe(0);
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("failed");
    expect(fetched?.lastError).toContain("budget exhausted");
  });
});

describe("Worker", () => {
  useQueue();
  it("dispatches by kind and records success", async () => {
    const seen: Record<string, unknown>[] = [];
    registerHandler("greet", async (payload) => {
      seen.push(payload);
      return { greeted: payload["name"] };
    });
    const j = await queue.enqueue({ kind: "greet", payload: { name: "Sample" } });
    const worker = new Worker(queue, { logger: () => {} });
    await worker.drainOnce();
    expect(seen).toEqual([{ name: "Sample" }]);
    const fetched = await queue.get(j.id);
    expect(fetched?.status).toBe("succeeded");
    expect(fetched?.result).toEqual({ greeted: "Sample" });
    expect(worker.getStats().succeeded).toBe(1);
  });

  it("retries via fail() when handler throws and budget remains", async () => {
    registerHandler("flaky", async () => {
      throw new Error("transient");
    });
    const j = await queue.enqueue({ kind: "flaky", maxRetries: 2 });
    const worker = new Worker(queue, { logger: () => {} });
    await worker.drainOnce();
    const after = await queue.get(j.id);
    expect(after?.status).toBe("pending");
    expect(after?.retryCount).toBe(1);
    expect(worker.getStats().retried).toBe(1);
  });

  it("marks as failed when no handler is registered", async () => {
    const j = await queue.enqueue({ kind: "ghost", maxRetries: 0 });
    const worker = new Worker(queue, { logger: () => {} });
    await worker.drainOnce();
    const after = await queue.get(j.id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toContain("ghost");
  });
});
