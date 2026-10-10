/**
 * When each cycle phase last ran (migration 127), so the scheduler can hold a
 * paid phase to one run per UTC day. Both directions are best-effort: a lost
 * record only means a phase is not held back, which is how it ran before.
 */
import type { Engine } from "../engine/interface.ts";

export async function recordPhaseRun(engine: Engine, phase: string, status: string): Promise<void> {
  try {
    await engine.query(
      `INSERT INTO cycle_phase_runs (phase, last_run_at, last_status)
       VALUES ($1, now(), $2)
       ON CONFLICT (phase) DO UPDATE
         SET last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status`,
      [phase, status],
    );
  } catch (e) {
    console.warn(`[cycle] could not record the ${phase} run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start of the UTC day `now` falls in. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Phases that have run since the start of the current UTC day. */
export async function phasesRunTodayUtc(engine: Engine, now: Date = new Date()): Promise<Set<string>> {
  try {
    const r = await engine.query<{ phase: string }>(
      `SELECT phase FROM cycle_phase_runs WHERE last_run_at >= $1`,
      [startOfUtcDay(now).toISOString()],
    );
    return new Set(r.rows.map((row) => row.phase));
  } catch (e) {
    console.warn(`[cycle] could not read today's phase runs: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}
