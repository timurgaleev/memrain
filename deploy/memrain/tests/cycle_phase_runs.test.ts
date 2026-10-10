/**
 * A synthesis phase runs at most once per UTC day.
 *
 * Locks: every phase run is recorded in cycle_phase_runs (migration 127), a
 * failed run included; the tick leaves out a synthesis phase recorded since the
 * start of the UTC day, keeps the free phases, and MEMRAIN_SYNTHESIS_ONCE_PER_DAY=0
 * turns the rule off.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { SYNTHESIS_PHASES, runPhase } from "../src/core/cycle/index.ts";
import { phasesRunTodayUtc, startOfUtcDay } from "../src/core/cycle/phase-runs.ts";
import { selectTickPhases, synthesisOncePerDay } from "../src/recipes/cycle.ts";
import { NOOP_PROGRESS } from "../src/core/output/progress.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-phase-runs-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recording phase runs", () => {
  it("records a run with its status, a failed run included", async () => {
    const e = storage.engine();
    await runPhase(e, "reflections", async () => ({ errors: [] }) as never, NOOP_PROGRESS);
    const origError = console.error;
    console.error = () => {};
    try {
      await runPhase(e, "patterns", async () => {
        throw new Error("judge down");
      }, NOOP_PROGRESS);
    } finally {
      console.error = origError;
    }
    const rows = await e.query<{ phase: string; last_status: string }>(
      `SELECT phase, last_status FROM cycle_phase_runs ORDER BY phase`,
    );
    expect(rows.rows).toEqual([
      { phase: "patterns", last_status: "fail" },
      { phase: "reflections", last_status: "ok" },
    ]);
    expect(await phasesRunTodayUtc(e)).toEqual(new Set(["patterns", "reflections"]));
  });

  it("counts only runs since the start of the UTC day", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO cycle_phase_runs (phase, last_run_at, last_status) VALUES
         ('reflections', '2026-10-09T23:59:00Z', 'ok'),
         ('patterns', '2026-10-10T00:01:00Z', 'ok')`,
    );
    const now = new Date("2026-10-10T07:00:00Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(await phasesRunTodayUtc(e, now)).toEqual(new Set(["patterns"]));
  });
});

describe("selecting a quiet tick's phases", () => {
  const none = new Set<string>();

  it("drops a synthesis phase that already ran today and keeps the rest", () => {
    const ran = new Set(["reflections", "lint"]);
    const phases = selectTickPhases({ inQuiet: true, synthEnabled: true, skipPhases: none, ranTodayUtc: ran });
    expect(phases).not.toContain("reflections");
    expect(phases).toContain("patterns");
    // The free maintenance phases are not held to once a day.
    expect(phases).toContain("lint");
    for (const p of SYNTHESIS_PHASES.filter((s) => s !== "reflections")) expect(phases).toContain(p);
  });

  it("is on unless MEMRAIN_SYNTHESIS_ONCE_PER_DAY=0", () => {
    expect(synthesisOncePerDay({})).toBe(true);
    expect(synthesisOncePerDay({ MEMRAIN_SYNTHESIS_ONCE_PER_DAY: "1" })).toBe(true);
    expect(synthesisOncePerDay({ MEMRAIN_SYNTHESIS_ONCE_PER_DAY: "0" })).toBe(false);
  });
});
