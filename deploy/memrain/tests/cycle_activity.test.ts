/**
 * The cycle loop reports each run to an optional live-activity hook.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import * as cycleCore from "../src/core/cycle/index.ts";
import { startCycleLoop, type CycleRunEvent } from "../src/recipes/cycle.ts";

let tmp: string;
let storage: Storage;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-cycle-activity-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setEnv("MEMRAIN_CYCLE_FIRST_TICK_DELAY_MS", "0");
  setEnv("MEMRAIN_CYCLE_SKIP_PHASES", cycleCore.ALL_PHASES.join(","));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete saved[k];
  }
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

async function runOnce(onRun: (e: CycleRunEvent) => void): Promise<void> {
  const loop = startCycleLoop(storage, { intervalMs: 3_600_000, onRun });
  try {
    await until(() => calls > 0);
  } finally {
    await loop.stop();
  }
}

let calls = 0;
const report = (status: "ok" | "fail") => ({
  status,
  outcome: status === "fail" ? "partial" : "complete",
  phases: [],
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}) as unknown as Awaited<ReturnType<typeof cycleCore.runCycleOnce>>;

describe("cycle onRun hook", () => {
  beforeEach(() => { calls = 0; });

  it("reports start then end ok for a clean run", async () => {
    const spy = spyOn(cycleCore, "runCycleOnce").mockImplementation(async () => report("ok"));
    const events: CycleRunEvent[] = [];
    try {
      await runOnce(e => { events.push(e); if (e.phase === "end") calls++; });
    } finally { spy.mockRestore(); }
    expect(events.map(e => e.phase)).toEqual(["start", "end"]);
    expect(events[1]?.ok).toBe(true);
    expect(events[1]?.latencyMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("reports end ok false when the run returns a failed report", async () => {
    const spy = spyOn(cycleCore, "runCycleOnce").mockImplementation(async () => report("fail"));
    const events: CycleRunEvent[] = [];
    try {
      await runOnce(e => { events.push(e); if (e.phase === "end") calls++; });
    } finally { spy.mockRestore(); }
    expect(events.at(-1)).toMatchObject({ phase: "end", ok: false });
  }, 30_000);

  it("reports end ok false when the run throws", async () => {
    const spy = spyOn(cycleCore, "runCycleOnce").mockImplementation(async () => { throw new Error("boom"); });
    const events: CycleRunEvent[] = [];
    try {
      await runOnce(e => { events.push(e); if (e.phase === "end") calls++; });
    } finally { spy.mockRestore(); }
    expect(events.map(e => e.phase)).toEqual(["start", "end"]);
    expect(events[1]?.ok).toBe(false);
  }, 30_000);

  it("keeps running when the hook throws", async () => {
    const spy = spyOn(cycleCore, "runCycleOnce").mockImplementation(async () => { calls++; return report("ok"); });
    let hookCalls = 0;
    try {
      await runOnce(() => { hookCalls++; throw new Error("hook down"); });
      await until(() => hookCalls >= 2);
    } finally { spy.mockRestore(); }
    expect(hookCalls).toBe(2);
  }, 30_000);
});
