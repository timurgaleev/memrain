/**
 * The maintenance cycle seen as a daemon. Its loop and cadence stay in
 * recipes/cycle.ts; this is only the pause it obeys and the status it leaves.
 * Both directions fail open: a control table that cannot be read leaves the
 * cycle running exactly as it did before daemons existed.
 */
import type { Engine } from "../engine/interface.ts";
import { ALL, envSwitches, readControlsFor, recordRun, resolveControl } from "./controls.ts";
import { CYCLE_DAEMON } from "./registry.ts";

/** Why the cycle is paused, or null when it may run. */
export async function cycleDaemonPause(engine: Engine, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (envSwitches(env).disabled.has(CYCLE_DAEMON.name)) return "MEMRAIN_DAEMONS_DISABLED";
  try {
    const ctl = resolveControl(await readControlsFor(engine, CYCLE_DAEMON.name), CYCLE_DAEMON.name, ALL);
    if (!ctl.pausedBy) return null;
    // Never empty: the caller treats an empty string as "not paused".
    return ctl.pausedBy.paused_reason || `paused by ${ctl.pausedBy.paused_by || "operator"}`;
  } catch (e) {
    console.warn(`[cycle] could not read daemon controls, running unpaused: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function recordCycleRun(engine: Engine, ok: boolean, outcome: string): Promise<void> {
  try {
    await recordRun(engine, CYCLE_DAEMON.name, ok, outcome);
  } catch (e) {
    console.warn(`[cycle] could not record the run status: ${e instanceof Error ? e.message : String(e)}`);
  }
}
