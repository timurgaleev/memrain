import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { makeRemediationHandler, registerRemediationHandlers } from "../src/core/jobs/remediation-handlers.ts";
import { getHandler } from "../src/core/jobs/handlers.ts";
import { UnrecoverableJobError } from "../src/core/jobs/types.ts";
import { CYCLE_LOCK_ID, tryAcquireDbLock } from "../src/core/db-lock.ts";
import * as cycle from "../src/core/cycle/index.ts";
import * as command from "../src/commands/cycle.ts";

const report = (status: "ok" | "warn" | "fail"): cycle.CycleResult => ({
  schemaVersion: 2, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
  outcome: "complete", ok: status !== "fail", status,
  phases: [{ phase: "lint", ok: status !== "fail", status, durationMs: 1, ...(status === "fail" ? { error: "fixture phase failure" } : {}) }],
});
const ctx = { job: {} as never };
for (const status of ["warn", "fail"] as const) it(`remediation reports a ${status} phase honestly`, async () => {
  const handler = makeRemediationHandler({ runCyclePhase: async () => report(status) });
  const run = handler({ action: "cycle-phase", phase: "lint" }, ctx);
  if (status === "fail") await expect(run).rejects.toThrow(UnrecoverableJobError);
  else expect(await run).toMatchObject({ status: "warn", phases: report(status).phases });
});
it("retries a cycle that was skipped", async () => {
  const handler = makeRemediationHandler({ runCyclePhase: async () => cycle.skippedCycleResult("cycle_already_running", ["lint"]) });
  await expect(handler({ action: "cycle-phase", phase: "lint" }, ctx)).rejects.toThrow(/cycle_already_running/);
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`remediation cycle ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("contends for the cycle lock without opening another Storage", async () => {
    const oldCommand = spyOn(command, "runCycle").mockResolvedValue(undefined);
    const runner = spyOn(cycle, "runCycleOnce").mockResolvedValue(report("ok"));
    const held = await tryAcquireDbLock(db.storage.engine(), CYCLE_LOCK_ID, 5);
    try {
      registerRemediationHandlers(db.storage);
      await expect(getHandler("remediation")!({ action: "cycle-phase", phase: "lint" }, ctx)).rejects.toThrow(/cycle_already_running/);
      expect(runner).not.toHaveBeenCalled();
      expect(oldCommand).not.toHaveBeenCalled();
    } finally { await held?.release(); runner.mockRestore(); oldCommand.mockRestore(); }
  });
  it("uses the existing storage, propagates cancellation and releases its lock", async () => {
    const abort = new AbortController();
    let seenStorage: unknown;
    let lockHeld = false;
    const runner = spyOn(cycle, "runCycleOnce").mockImplementation(async (engine, opts = {}) => {
      expect(engine).toBe(db.storage.engine());
      seenStorage = opts.storage;
      expect(opts.phases).toEqual(["lint"]);
      lockHeld = await opts.fence!();
      abort.abort(new Error("worker shutdown"));
      expect(opts.signal?.aborted).toBe(true);
      return report("warn");
    });
    try {
      registerRemediationHandlers(db.storage);
      await expect(getHandler("remediation")!({ action: "cycle-phase", phase: "lint" }, { ...ctx, signal: abort.signal })).rejects.toThrow("worker shutdown");
      expect(seenStorage).toBe(db.storage);
      expect(lockHeld).toBe(true);
      const next = await tryAcquireDbLock(db.storage.engine(), CYCLE_LOCK_ID, 5);
      expect(next).not.toBeNull();
      await next?.release();
    } finally { runner.mockRestore(); }
  });

});
