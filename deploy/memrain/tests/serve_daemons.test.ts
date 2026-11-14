/**
 * serve's wiring of the daemon scheduler and worker lanes: both off unless
 * their env switch is set, and /health reports the scheduler only where one
 * runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { loadConfig } from "../src/core/config.ts";
import { resolveQuiescence, MAINTENANCE_ENV } from "../src/core/quiescence.ts";
import { startBackgroundWork, workerLaneOptions, type BackgroundDeps } from "../src/commands/serve.ts";
import { daemonSchedulerHealth, stopDaemonScheduler } from "../src/core/daemons/scheduler.ts";
import { probeLiveness } from "../src/http/health.ts";
import type { Worker } from "../src/core/jobs/worker.ts";

let dir: string;
let storage: Storage;
const saved = process.env.MEMRAIN_DAEMONS;

const deps = () => ({
  registerSource: mock(async () => {}),
  sweepCodeRoots: mock(async () => ({ scanned: 0, reindexed: 0, skipped: 0, parseErrors: 0, errors: [], perRoot: [] })),
  startCycleLoop: mock(() => ({ stop: async () => {} })),
  startWorker: mock((_w: Worker) => {}),
  workerIntervalMs: 20,
}) as unknown as BackgroundDeps;

async function boot(env: Record<string, string>) {
  const log = console.log;
  console.log = () => {};
  try {
    return startBackgroundWork(storage, {} as ReturnType<typeof loadConfig>, resolveQuiescence(env), deps());
  } finally {
    console.log = log;
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memrain-serve-daemons-"));
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterEach(async () => {
  await stopDaemonScheduler();
  if (saved === undefined) delete process.env.MEMRAIN_DAEMONS; else process.env.MEMRAIN_DAEMONS = saved;
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon scheduler in serve", () => {
  it("is not started, and /health carries no daemons block, without MEMRAIN_DAEMONS=1", async () => {
    delete process.env.MEMRAIN_DAEMONS;
    const { worker } = await boot({});
    await worker.stop();
    expect(daemonSchedulerHealth()).toBeNull();
    expect((await probeLiveness(storage)).body.daemons).toBeUndefined();
  });

  it("starts with MEMRAIN_DAEMONS=1 and /health reports leadership and tick age", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    const { worker } = await boot({});
    await worker.stop();
    const h = daemonSchedulerHealth();
    expect(h).toEqual({ leader: false, tick_age_s: null });
    expect((await probeLiveness(storage)).body.daemons).toEqual({ leader: false, tick_age_s: null });
  });

  it("stays off in maintenance", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    const { worker } = await boot({ [MAINTENANCE_ENV]: "1" });
    await worker.stop();
    expect(daemonSchedulerHealth()).toBeNull();
  });
});

describe("workerLaneOptions", () => {
  it("keeps concurrency 1 unless MEMRAIN_JOB_CONCURRENCY says otherwise", () => {
    expect(workerLaneOptions({}).concurrency).toBe(1);
    expect(workerLaneOptions({ MEMRAIN_JOB_CONCURRENCY: "2" }).concurrency).toBe(2);
    for (const bad of ["0", "-1", "2x", "65", ""]) {
      expect(workerLaneOptions({ MEMRAIN_JOB_CONCURRENCY: bad }).concurrency).toBe(1);
    }
  });

  it("puts remediation and the agent loop in the long lane", () => {
    expect(workerLaneOptions({}).longKinds).toEqual(expect.arrayContaining(["remediation", "subagent"]));
  });
});
