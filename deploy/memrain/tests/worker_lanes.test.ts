/**
 * Worker lanes: with concurrency >= 2 one slot is kept for short jobs, so long
 * work (a daemon run, a remediation) can never take every slot.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-lanes-"));
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

const running = async () =>
  (await storage.engine().query<{ id: string }>(`SELECT id FROM jobs WHERE status = 'running' ORDER BY id`)).rows.map(r => r.id);

async function until(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("Queue.claim excludeKinds", () => {
  it("skips the excluded kinds and still claims the rest", async () => {
    await queue.enqueue({ kind: "long", id: "a-long", priority: 1 });
    await queue.enqueue({ kind: "short", id: "b-short", priority: 9 });
    expect((await queue.claim({ excludeKinds: ["long"] }))?.id).toBe("b-short");
    expect(await queue.claim({ excludeKinds: ["long"] })).toBeNull();
    expect((await queue.claim())?.id).toBe("a-long");
  });
});

describe("worker lanes", () => {
  it("concurrency 2 with two long jobs and one short: the short one gets the reserved slot", async () => {
    const release = Promise.withResolvers<void>();
    registerHandler("long", async () => { await release.promise; return {}; });
    registerHandler("short", async () => { await release.promise; return {}; });
    await queue.enqueue({ kind: "long", id: "long-1", priority: 1 });
    await queue.enqueue({ kind: "long", id: "long-2", priority: 1 });
    await queue.enqueue({ kind: "short", id: "short-1", priority: 9 });
    const worker = new Worker(queue, { intervalMs: 10, concurrency: 2, longKinds: ["long"], logger: () => {} });
    worker.start();
    try {
      await until(async () => (await running()).length === 2);
      await Bun.sleep(50);
      expect(await running()).toEqual(["long-1", "short-1"]);
    } finally {
      release.resolve();
      await worker.stop();
    }
  });

  it("concurrency 1 keeps today's single shared slot", async () => {
    const release = Promise.withResolvers<void>();
    registerHandler("long", async () => { await release.promise; return {}; });
    await queue.enqueue({ kind: "long", id: "long-1" });
    const worker = new Worker(queue, { intervalMs: 10, concurrency: 1, longKinds: ["long"], logger: () => {} });
    worker.start();
    try {
      await until(async () => (await running()).length === 1);
      expect(await running()).toEqual(["long-1"]);
    } finally {
      release.resolve();
      await worker.stop();
    }
  });
});
