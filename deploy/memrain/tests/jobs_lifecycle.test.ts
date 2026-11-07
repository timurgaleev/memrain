/**
 * Jobs lifecycle surface (migration 083) — prune/remove, progress + token/cost
 * accounting, kind-filtered claims, the validated submit helper, and the
 * end-to-end smoke self-test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import {
  registerHandler,
  _resetHandlersForTesting,
} from "../src/core/jobs/handlers.ts";
import {
  submitJob,
  getJobProgress,
  runJobsSmoke,
} from "../src/core/jobs/lifecycle.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-jobslc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
});

afterEach(async () => {
  _resetHandlersForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Force a job into a status with a back-dated updated_at (for prune tests). */
async function forceRow(
  id: string,
  status: string,
  ageDays: number,
): Promise<void> {
  await storage.raw().query(
    `UPDATE jobs SET status = $2, updated_at = NOW() - ($3::int * INTERVAL '1 day')
      WHERE id = $1`,
    [id, status, ageDays],
  );
}

describe("Queue.prune", () => {
  it("deletes old terminal jobs and keeps recent + non-terminal ones", async () => {
    await queue.enqueue({ kind: "a", id: "old-done" });
    await queue.enqueue({ kind: "a", id: "old-failed" });
    await queue.enqueue({ kind: "a", id: "fresh-done" });
    await queue.enqueue({ kind: "a", id: "old-pending" });
    await forceRow("old-done", "succeeded", 45);
    await forceRow("old-failed", "failed", 45);
    await forceRow("fresh-done", "succeeded", 1);
    await forceRow("old-pending", "pending", 45);

    const n = await queue.prune(); // default: 30 days, all terminal statuses
    expect(n).toBe(2);
    expect(await queue.get("old-done")).toBeNull();
    expect(await queue.get("old-failed")).toBeNull();
    expect((await queue.get("fresh-done"))?.status).toBe("succeeded");
    expect((await queue.get("old-pending"))?.status).toBe("pending");
  });

  it("honours olderThan and a status subset", async () => {
    await queue.enqueue({ kind: "a", id: "j1" });
    await queue.enqueue({ kind: "a", id: "j2" });
    await forceRow("j1", "succeeded", 5);
    await forceRow("j2", "failed", 5);
    const n = await queue.prune({
      olderThan: new Date(Date.now() - 86_400_000),
      statuses: ["succeeded"],
    });
    expect(n).toBe(1);
    expect(await queue.get("j1")).toBeNull();
    expect((await queue.get("j2"))?.status).toBe("failed");
  });

  it("dryRun reports the would-be-deleted count without deleting", async () => {
    await queue.enqueue({ kind: "a", id: "dry-old" });
    await queue.enqueue({ kind: "a", id: "dry-fresh" });
    await forceRow("dry-old", "succeeded", 45);
    await forceRow("dry-fresh", "succeeded", 1);

    const wouldPrune = await queue.prune({ dryRun: true });
    expect(wouldPrune).toBe(1);
    expect((await queue.get("dry-old"))?.status).toBe("succeeded");
    expect((await queue.get("dry-fresh"))?.status).toBe("succeeded");

    // Same selection, real prune: the row the dry run counted is now gone.
    const n = await queue.prune();
    expect(n).toBe(1);
    expect(await queue.get("dry-old")).toBeNull();
    expect((await queue.get("dry-fresh"))?.status).toBe("succeeded");
  });

  it("rejects a non-terminal status", async () => {
    await expect(queue.prune({ statuses: ["running" as never] })).rejects.toThrow(
      "not a terminal status",
    );
  });
});

describe("Queue.remove", () => {
  it("deletes terminal rows only", async () => {
    const pending = await queue.enqueue({ kind: "a", id: "p1" });
    expect(await queue.remove(pending.id)).toBe(false);
    await forceRow("p1", "succeeded", 0);
    expect(await queue.remove("p1")).toBe(true);
    expect(await queue.get("p1")).toBeNull();
  });
});

describe("progress + usage accounting", () => {
  it("updateProgress persists on a running job and no-ops after completion", async () => {
    await queue.enqueue({ kind: "a", id: "j1" });
    const claimed = await queue.claim();
    expect(claimed?.id).toBe("j1");
    expect(await queue.updateProgress("j1", 1, { step: 2, of: 5 })).toBe(true);
    expect((await queue.get("j1"))?.progress).toEqual({ step: 2, of: 5 });
    await queue.complete("j1", 1, {});
    expect(await queue.updateProgress("j1", 1, { step: 5, of: 5 })).toBe(false);
    // Progress written while running survives completion.
    expect((await queue.get("j1"))?.progress).toEqual({ step: 2, of: 5 });
  });

  it("recordUsage accumulates token/cost deltas while running", async () => {
    await queue.enqueue({ kind: "a", id: "j1" });
    await queue.claim();
    expect(
      await queue.recordUsage("j1", 1, { tokensInput: 100, tokensOutput: 20, costUsd: 0.01 }),
    ).toBe(true);
    expect(
      await queue.recordUsage("j1", 1, { tokensInput: 50, tokensCacheRead: 400, costUsd: 0.005 }),
    ).toBe(true);
    const j = await queue.get("j1");
    expect(j?.tokensInput).toBe(150);
    expect(j?.tokensOutput).toBe(20);
    expect(j?.tokensCacheRead).toBe(400);
    expect(j?.costUsd).toBeCloseTo(0.015, 6);
  });

  it("recordUsage rejects no-op and non-running writes", async () => {
    await queue.enqueue({ kind: "a", id: "j1" });
    expect(await queue.recordUsage("j1", 1, {})).toBe(false);
    expect(await queue.recordUsage("j1", 1, { tokensInput: 10 })).toBe(false); // pending
    expect(await queue.recordUsage("j1", 1, { tokensInput: -5 })).toBe(false); // clamped
  });

  it("the worker exposes updateProgress/recordUsage in the handler context", async () => {
    registerHandler("with-ctx", async (_payload, ctx) => {
      await ctx.updateProgress?.({ phase: "half" });
      await ctx.recordUsage?.({ tokensInput: 7, tokensOutput: 3, costUsd: 0.002 });
      return { done: true };
    });
    const job = await queue.enqueue({ kind: "with-ctx" });
    const worker = new Worker(queue);
    await worker.drainOnce();
    const final = await queue.get(job.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.progress).toEqual({ phase: "half" });
    expect(final?.tokensInput).toBe(7);
    expect(final?.tokensOutput).toBe(3);
    expect(final?.costUsd).toBeCloseTo(0.002, 6);
  });
});

describe("kind-filtered claim", () => {
  it("claims only the requested kinds", async () => {
    await queue.enqueue({ kind: "alpha", id: "a1", priority: 1 });
    await queue.enqueue({ kind: "beta", id: "b1", priority: 2 });
    const b = await queue.claim({ kinds: ["beta"] });
    expect(b?.id).toBe("b1");
    expect(await queue.claim({ kinds: ["beta"] })).toBeNull();
    const a = await queue.claim({ kinds: ["alpha", "gamma"] });
    expect(a?.id).toBe("a1");
  });
});

describe("submitJob", () => {
  it("rejects a malformed kind up front", async () => {
    await expect(submitJob(queue, { kind: "Bad Kind!" })).rejects.toThrow(
      "invalid kind",
    );
  });

  it("refuses an unknown kind and inserts nothing", async () => {
    await expect(submitJob(queue, { kind: "no_such_kind" })).rejects.toThrow(
      "unknown kind",
    );
    const r = await storage
      .engine()
      .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs");
    expect(r.rows[0]?.n).toBe(0);
  });

  it("enqueues a built-in kind with an empty registry", async () => {
    const j = await submitJob(queue, { kind: "page_mirror", priority: 3 });
    expect(j.status).toBe("pending");
    expect(j.priority).toBe(3);
  });

  it("enqueues a kind registered in this process", async () => {
    registerHandler("embed.backfill", async () => ({}));
    const j = await submitJob(queue, { kind: "embed.backfill" });
    expect(j.kind).toBe("embed.backfill");
  });
});

describe("getJobProgress", () => {
  it("returns null for a missing job and the envelope for a real one", async () => {
    expect(await getJobProgress(queue, "nope")).toBeNull();
    await queue.enqueue({ kind: "a", id: "j1" });
    await queue.claim();
    await queue.updateProgress("j1", 1, { pct: 40 });
    expect(await getJobProgress(queue, "j1")).toEqual({
      id: "j1",
      kind: "a",
      status: "running",
      progress: { pct: 40 },
    });
  });
});

describe("runJobsSmoke", () => {
  it("round-trips a noop job through the real worker path and cleans up", async () => {
    const r = await runJobsSmoke(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.status).toBe("succeeded");
    expect(await queue.get(r.jobId)).toBeNull(); // row removed
  });

  it("does not drain unrelated pending jobs", async () => {
    await queue.enqueue({ kind: "unrelated", id: "u1" });
    const r = await runJobsSmoke(storage.engine());
    expect(r.ok).toBe(true);
    expect((await queue.get("u1"))?.status).toBe("pending");
  });
});

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

/** NUL and a lone surrogate are refused by a jsonb cast; the queue well-forms them. */
function wellFormedJobCases(engine: () => Engine, tag: string): void {
  const fresh = () => `jb07-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it(`stores an enqueued payload carrying NUL or a lone surrogate as well-formed jsonb (${tag})`, async () => {
    const q = new Queue(engine());
    const id = fresh();
    try {
      await q.enqueue({ kind: id, id, payload: { text: "p\u0000q", bad: "r\ud800s" } });
      expect((await q.get(id))!.payload).toEqual({ text: "pq", bad: "r\uFFFDs" });
    } finally {
      await engine().query(`DELETE FROM jobs WHERE id = $1`, [id]);
    }
  });

  it(`stores a result and progress carrying NUL or a lone surrogate as well-formed jsonb (${tag})`, async () => {
    const q = new Queue(engine());
    const id = fresh();
    try {
      await q.enqueue({ kind: id, id });
      const claimed = await q.claim({ kinds: [id] });
      const gen = claimed!.claimGeneration;
      expect(await q.updateProgress(id, gen, { note: "a\u0000b", bad: "x\ud800y" })).toBe(true);
      const done = await q.complete(id, gen, { note: "c\u0000d" });
      expect(done!.result).toEqual({ note: "cd" });
      expect((await q.get(id))!.progress).toEqual({ note: "ab", bad: "x\uFFFDy" });
    } finally {
      await engine().query(`DELETE FROM jobs WHERE id = $1`, [id]);
    }
  });
}

describe("jsonb well-forming on PGLite", () => {
  wellFormedJobCases(() => storage.engine(), "pglite");
});

describe.skipIf(!PG_URL)("jsonb well-forming on Postgres", () => {
  let pg: PostgresEngine;
  beforeAll(async () => {
    pg = new PostgresEngine({ url: PG_URL! });
    await new Storage(pg).init();
  });
  afterAll(async () => {
    await pg.close();
  });
  wellFormedJobCases(() => pg, "postgres");
});
