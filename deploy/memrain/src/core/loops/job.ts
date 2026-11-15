/**
 * The `loops_sweep` job handler behind the scheduler's gate (MEMRAIN_DAEMONS,
 * pauses, the daemon's enabled switch). One run sweeps the one source the
 * scheduler queued it for.
 */
import type { Engine } from "../engine/interface.ts";
import { registerDaemonHandler } from "../daemons/scheduler.ts";
import { DEFAULT_DAEMON_SOURCE } from "../daemons/registry.ts";
import { LOOPS_SWEEP_DAEMON } from "./daemon.ts";
import { sweepLoops } from "./store.ts";

/** Accept the `loops_sweep` kind in this process; serve calls this at boot. */
export function registerLoopsSweepDaemon(engine: Engine, opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {}): void {
  registerDaemonHandler(engine, LOOPS_SWEEP_DAEMON, async (payload) => {
    const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : DEFAULT_DAEMON_SOURCE;
    return { ...await sweepLoops(engine, sourceId, opts.now ? opts.now() : new Date()) };
  }, opts.env ? { env: opts.env } : {});
}
