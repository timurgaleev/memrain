/**
 * The maintenance cycle as a daemon: it keeps its own loop and cadence, but a
 * pause in daemon_controls stops its ticks and each run leaves its status.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { ALL_PHASES } from "../src/core/cycle/index.ts";
import { startCycleLoop } from "../src/recipes/cycle.ts";
import { pauseDaemon, readControls, resumeDaemon } from "../src/core/daemons/controls.ts";

let tmp: string;
let storage: Storage;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-cycle-daemon-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setEnv("MEMRAIN_CYCLE_FIRST_TICK_DELAY_MS", "0");
  setEnv("MEMRAIN_CYCLE_SKIP_PHASES", ALL_PHASES.join(","));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete saved[k];
  }
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

const cycleRow = async () => (await readControls(storage.engine())).find(r => r.daemon === "cycle" && r.source_id === "*");

describe("cycle daemon", () => {
  it("records each run's outcome", async () => {
    const loop = startCycleLoop(storage, { intervalMs: 3_600_000 });
    try {
      await until(async () => (await cycleRow())?.last_run_at != null);
      const row = (await cycleRow())!;
      expect(row.last_outcome).toBe("complete");
      expect(row.consecutive_failures).toBe(0);
    } finally { await loop.stop(); }
  }, 30_000);

  it("skips its tick while paused and runs again once resumed", async () => {
    await pauseDaemon(storage.engine(), { daemon: "cycle", by: "cli", reason: "test" });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const loop = startCycleLoop(storage, { intervalMs: 60_000 });
    try {
      await until(async () => lines.some(l => l.includes("reason=paused")));
      expect((await cycleRow())?.last_run_at ?? null).toBeNull();
    } finally {
      console.log = orig;
      await loop.stop();
    }

    await resumeDaemon(storage.engine(), { daemon: "cycle", by: "cli" });
    const again = startCycleLoop(storage, { intervalMs: 3_600_000 });
    try {
      await until(async () => (await cycleRow())?.last_run_at != null);
    } finally { await again.stop(); }
  }, 30_000);

  it("a global pause stops the cycle too", async () => {
    await pauseDaemon(storage.engine(), { daemon: "*", by: "cli" });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const loop = startCycleLoop(storage, { intervalMs: 60_000 });
    try {
      await until(async () => lines.some(l => l.includes("reason=paused")));
    } finally {
      console.log = orig;
      await loop.stop();
    }
  }, 30_000);
});
