/**
 * Job runtime: unrecoverable failures dead-letter at once, every attempt gets
 * an abort signal, a live attempt renews its lease so the stall sweep leaves
 * it alone (and a lost lease aborts it), an LLM outage defers the job without
 * spending a retry, a dead job's id can be revived, and paid calls inside a
 * job are tagged with the job and its submitter.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue, stallGraceMs } from "../src/core/jobs/queue.ts";
import { MAX_DEFERS, Worker } from "../src/core/jobs/worker.ts";
import { UnrecoverableJobError } from "../src/core/jobs/types.ts";
import {
  _resetHandlersForTesting,
  registerHandler,
} from "../src/core/jobs/handlers.ts";
import {
  _resetLlmHaltForTests,
  haltOf,
  LLM_HALT_MAX_MS,
  noteHalt,
} from "../src/core/jobs/llm-halt.ts";
import { bucketJobErrors, classifyJobError } from "../src/core/jobs/error-classify.ts";
import { kindDefaultTimeoutMs } from "../src/core/jobs/kind-defaults.ts";
import { BedrockHalted, resetBedrockCircuitForTests } from "../src/core/llm/bedrock-errors.ts";
import { currentSpendClient, currentSpendTags } from "../src/core/budget.ts";
import { checkQueueHealth } from "../src/core/doctor-ops.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;
const savedHaltEnv = process.env.MEMRAIN_JOB_LLM_HALT;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-jobruntime-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
  _resetLlmHaltForTests();
  resetBedrockCircuitForTests();
  delete process.env.MEMRAIN_JOB_LLM_HALT;
});

afterEach(async () => {
  if (savedHaltEnv === undefined) delete process.env.MEMRAIN_JOB_LLM_HALT;
  else process.env.MEMRAIN_JOB_LLM_HALT = savedHaltEnv;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const quiet = { logger: () => {} };

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("unrecoverable failures", () => {
  it("dead-letter at once with retries left", async () => {
    registerHandler("bad", async () => {
      throw new UnrecoverableJobError("payload.slug is required");
    });
    await queue.enqueue({ kind: "bad", id: "u", maxRetries: 3 });
    const worker = new Worker(queue, quiet);
    await worker.drainOnce();
    const row = await queue.get("u");
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("unrecoverable: payload.slug is required");
    expect(worker.getStats().failed).toBe(1);
  });

  it("a kind with no handler fails terminally", async () => {
    await queue.enqueue({ kind: "ghost", id: "g", maxRetries: 3 });
    await new Worker(queue, quiet).drainOnce();
    const row = await queue.get("g");
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("no handler registered");
  });
});

describe("attempt abort signal", () => {
  it("fires when the job's timeout abandons the handler", async () => {
    let signal: AbortSignal | undefined;
    registerHandler("slow", async (_p, ctx) => {
      signal = ctx.signal;
      await new Promise(() => {});
    });
    await queue.enqueue({ kind: "slow", id: "s", timeoutMs: 50 });
    await new Worker(queue, quiet).drainOnce();
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect((await queue.get("s"))?.status).toBe("failed");
  });
});

describe("lease renewal", () => {
  it("keeps a live attempt's row away from the stall sweep", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registerHandler("long", async () => {
      await gate;
      return { ok: true };
    });
    await queue.enqueue({ kind: "long", id: "l" });
    const worker = new Worker(queue, { ...quiet, lockSeconds: 0.3 });
    const drained = worker.drainOnce();
    // Past the original 300 ms lock: only renewal keeps the row claimed.
    await new Promise((r) => setTimeout(r, 900));
    const swept = await queue.handleStalled({ graceMs: 0 });
    expect(swept.requeued).toBe(0);
    expect((await queue.get("l"))?.status).toBe("running");
    release();
    await drained;
    expect((await queue.get("l"))?.status).toBe("succeeded");
    expect(worker.getStats().fenced).toBe(0);
  });

  it("aborts the attempt once its claim is gone, and writes nothing", async () => {
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const running = new Promise<void>((r) => {
      entered = r;
    });
    registerHandler("hang", async (_p, ctx) => {
      signal = ctx.signal;
      entered();
      await new Promise(() => {});
    });
    await queue.enqueue({ kind: "hang", id: "c" });
    const worker = new Worker(queue, { ...quiet, lockSeconds: 0.15 });
    const drained = worker.drainOnce();
    await running;
    await queue.cancel("c");
    const done = await waitFor(() => signal?.aborted === true, 3000);
    expect(done).toBe(true);
    await drained;
    expect((await queue.get("c"))?.status).toBe("cancelled");
    expect(worker.getStats()).toMatchObject({ fenced: 1, succeeded: 0, failed: 0 });
  });
});

describe("stall sweep grace", () => {
  it("waits the grace past lock_until before requeuing", async () => {
    await queue.enqueue({ kind: "x", id: "g1" });
    const t0 = new Date(Date.now() + 60_000);
    await queue.claim({ now: t0, lockSeconds: 10 });
    const early = await queue.handleStalled({ now: new Date(t0.getTime() + 20_000) });
    expect(early.requeued).toBe(0);
    const late = await queue.handleStalled({ now: new Date(t0.getTime() + 41_000) });
    expect(late.requeued).toBe(1);
  });

  it("reads MEMRAIN_JOB_STALL_GRACE_MS, digits only", () => {
    expect(stallGraceMs({})).toBe(30_000);
    expect(stallGraceMs({ MEMRAIN_JOB_STALL_GRACE_MS: "5000" })).toBe(5000);
    expect(stallGraceMs({ MEMRAIN_JOB_STALL_GRACE_MS: "5e3" })).toBe(30_000);
  });
});

describe("LLM outage defer", () => {
  it("puts the job back to wait without spending a retry", async () => {
    registerHandler("llm", async () => {
      throw namedError("AccessDeniedException", "not authorized to invoke model");
    });
    await queue.enqueue({ kind: "llm", id: "d", maxRetries: 1 });
    const worker = new Worker(queue, quiet);
    const before = Date.now();
    await worker.drainOnce();
    const row = await queue.get("d");
    expect(row?.status).toBe("pending");
    expect(row?.retryCount).toBe(0);
    expect(row?.deferredCount).toBe(1);
    expect(row?.lastError).toMatch(/^deferred: access: /);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(worker.getStats().deferred).toBe(1);
  });

  it("defers on an open circuit, but not on the job's own stopped scope", () => {
    expect(haltOf(new BedrockHalted("quota", 0, "quota failure on m-1: spent"))).toEqual({
      cls: "quota",
      key: "m-1",
    });
    expect(haltOf(new BedrockHalted("other", 0, "the batch run ... timed out"))).toBeNull();
    expect(haltOf(namedError("ExpiredTokenException", "expired"))).toEqual({ cls: "credential", key: "*" });
    expect(haltOf(namedError("ResourceNotFoundException", "model not found"))?.cls).toBe("model_not_found");
    expect(haltOf(new Error("boom"))).toBeNull();
  });

  it("MEMRAIN_JOB_LLM_HALT=0 restores the ordinary retry", async () => {
    process.env.MEMRAIN_JOB_LLM_HALT = "0";
    registerHandler("llm", async () => {
      throw namedError("ThrottlingException", "slow down");
    });
    await queue.enqueue({ kind: "llm", id: "o", maxRetries: 2 });
    await new Worker(queue, quiet).drainOnce();
    const row = await queue.get("o");
    expect(row?.retryCount).toBe(1);
    expect(row?.deferredCount).toBe(0);
  });

  it("past the defer cap the job fails the ordinary way", async () => {
    registerHandler("llm", async () => {
      throw namedError("ThrottlingException", "slow down");
    });
    await queue.enqueue({ kind: "llm", id: "cap", maxRetries: 0 });
    await storage.engine().exec(`UPDATE jobs SET deferred_count = ${MAX_DEFERS} WHERE id = 'cap'`);
    await new Worker(queue, quiet).drainOnce();
    expect((await queue.get("cap"))?.status).toBe("failed");
  });

  it("defer is fenced by claim generation", async () => {
    await queue.enqueue({ kind: "x", id: "f" });
    await queue.claim();
    expect(await queue.defer("f", 0, new Date(), "x")).toBe(false);
    expect(await queue.defer("f", 1, new Date(), "x")).toBe(true);
    expect((await queue.get("f"))?.status).toBe("pending");
  });

  it("cooldowns hold during an outage, double after it, cap, and start over", () => {
    const t = 1_000_000;
    const first = noteHalt("*", "credential", t);
    expect(first - t).toBe(5 * 60_000);
    expect(noteHalt("*", "credential", t + 1000)).toBe(first);
    const second = noteHalt("*", "credential", first + 1);
    expect(second - (first + 1)).toBe(10 * 60_000);
    let until = second;
    for (let i = 0; i < 5; i++) until = noteHalt("*", "credential", until + 1);
    expect(until - noteHalt("*", "credential", until - 1)).toBe(0);
    const capped = noteHalt("*", "credential", until + 1);
    expect(capped - (until + 1)).toBe(LLM_HALT_MAX_MS);
    // Quiet for a full maximum cooldown: back to the base.
    const fresh = noteHalt("*", "credential", capped + LLM_HALT_MAX_MS + 1);
    expect(fresh - (capped + LLM_HALT_MAX_MS + 1)).toBe(5 * 60_000);
    expect(noteHalt("m", "throttle", t) - t).toBe(60_000);
  });
});

describe("enqueueOrRevive", () => {
  it("creates, then reports the live row as existing", async () => {
    expect((await queue.enqueueOrRevive({ kind: "x", id: "r" })).outcome).toBe("created");
    expect((await queue.enqueueOrRevive({ kind: "x", id: "r" })).outcome).toBe("existing");
  });

  it("revives a failed or cancelled row with fresh budgets", async () => {
    await queue.enqueue({ kind: "x", id: "rf", maxRetries: 0 });
    const j = await queue.claim();
    await queue.fail("rf", j!.claimGeneration, "boom");
    const r = await queue.enqueueOrRevive({ kind: "x", id: "rf" });
    expect(r.outcome).toBe("revived");
    expect(r.job.status).toBe("pending");
    expect(r.job.retryCount).toBe(0);
    expect(r.job.lastError).toBeNull();

    await queue.enqueue({ kind: "x", id: "rc" });
    await queue.cancel("rc");
    expect((await queue.enqueueOrRevive({ kind: "x", id: "rc" })).outcome).toBe("revived");
  });

  it("never revives a succeeded row, or one of another kind", async () => {
    await queue.enqueue({ kind: "x", id: "rs" });
    const j = await queue.claim();
    await queue.complete("rs", j!.claimGeneration, {});
    const r = await queue.enqueueOrRevive({ kind: "x", id: "rs" });
    expect(r.outcome).toBe("existing");
    expect(r.job.status).toBe("succeeded");

    await queue.enqueue({ kind: "x", id: "rk" });
    await queue.cancel("rk");
    expect((await queue.enqueueOrRevive({ kind: "y", id: "rk" })).outcome).toBe("existing");
    expect((await queue.get("rk"))?.status).toBe("cancelled");
  });
});

describe("spend attribution", () => {
  it("runs the handler under the job id and its submitter", async () => {
    const seen: { jobId?: string; client: string | null }[] = [];
    registerHandler("paid", async () => {
      seen.push({ jobId: currentSpendTags().jobId, client: currentSpendClient() });
    });
    await queue.enqueue({ kind: "paid", id: "t1", submittedBy: "client-a", authority: {} });
    await queue.enqueue({ kind: "paid", id: "t2" });
    await new Worker(queue, quiet).drainOnce();
    expect(seen).toContainEqual({ jobId: "t1", client: "client-a" });
    expect(seen).toContainEqual({ jobId: "t2", client: null });
  });
});

describe("kind defaults", () => {
  it("cap the kinds memrain ships and leave others alone", () => {
    expect(kindDefaultTimeoutMs("remediation")).toBe(30 * 60_000);
    expect(kindDefaultTimeoutMs("page_mirror")).toBe(10 * 60_000);
    expect(kindDefaultTimeoutMs("chronicle_extract")).toBe(10 * 60_000);
    expect(kindDefaultTimeoutMs("ingest_capture")).toBe(5 * 60_000);
    expect(kindDefaultTimeoutMs("subagent")).toBeUndefined();
    expect(kindDefaultTimeoutMs("toString")).toBeUndefined();
  });
});

describe("queue stats and error buckets", () => {
  it("statsByKind counts per kind with deferred rows", async () => {
    await queue.enqueue({ kind: "a", id: "a1" });
    await queue.enqueue({ kind: "a", id: "a2" });
    await queue.enqueue({ kind: "b", id: "b1" });
    const j = await queue.claim({ kinds: ["b"] });
    await queue.defer("b1", j!.claimGeneration, new Date(Date.now() + 60_000), "throttle: x");
    const stats = await queue.statsByKind();
    expect(stats.map((s) => s.kind)).toEqual(["a", "b"]);
    expect(stats[0]).toMatchObject({ kind: "a", pending: 2, deferred: 0 });
    expect(stats[1]).toMatchObject({ kind: "b", pending: 1, deferred: 1, running: 0 });
  });

  it("classifies the errors the worker writes", () => {
    expect(classifyJobError("unrecoverable: missing slug")).toBe("unrecoverable");
    expect(classifyJobError("deferred: access: denied")).toBe("deferred");
    expect(classifyJobError("job exceeded its 50ms timeout")).toBe("timeout");
    expect(classifyJobError("stall budget exhausted")).toBe("stall");
    expect(classifyJobError("no handler registered for kind 'x'")).toBe("no_handler");
    expect(classifyJobError("ExpiredTokenException: The security token included in the request is expired")).toBe("credential");
    expect(classifyJobError("ThrottlingException: Too many requests")).toBe("throttle");
    expect(classifyJobError("something odd")).toBe("unknown");
    expect(classifyJobError(null)).toBe("unknown");
    expect(bucketJobErrors(["stall budget exhausted", "boom", "stall budget exhausted"])).toEqual([
      { bucket: "stall", count: 2 },
      { bucket: "unknown", count: 1 },
    ]);
  });

  it("doctor reports deferred rows and the day's failures by cause", async () => {
    await queue.enqueue({ kind: "a", id: "d1" });
    const j = await queue.claim();
    await queue.defer("d1", j!.claimGeneration, new Date(Date.now() + 60_000), "quota: x");
    await queue.enqueue({ kind: "a", id: "f1", maxRetries: 0 });
    const k = await queue.claim();
    await queue.fail("f1", k!.claimGeneration, "unrecoverable: bad payload", { terminal: true });
    const r = await checkQueueHealth(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("deferred=1");
    expect(r.detail).toContain("failed_24h=1 (unrecoverable:1)");
  });
});
