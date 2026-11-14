/**
 * The daemons this process knows about: what each one queues, when, and how
 * it may be switched off. Code declares a daemon here; operators steer it
 * through `daemon_controls` (pause, enable, cron and zone overrides).
 *
 * A `schedule` of "external" names background work that keeps its own loop
 * (the maintenance cycle): the scheduler never queues it, but it still obeys a
 * pause and reports its last run, so every daemon is stopped and inspected the
 * same way.
 */
import type { Engine } from "../engine/interface.ts";
import { parseCron, assertTimeZone } from "./cron.ts";
import { CONNECTOR_SYNC_DAEMON } from "../connectors/sync-daemon.ts";

export type DaemonLane = "short" | "long";

/** Who a scheduled run is for. Without a grant the run is the operator's. */
export interface DaemonTarget {
  sourceId: string;
  submittedBy?: string;
  authority?: Record<string, unknown>;
}

export interface DaemonSpec {
  /** Lowercase id, also the job-id segment: `daemon:<name>:<source>:<window>`. */
  name: string;
  /** Job kind the scheduler queues. Ignored for an external daemon. */
  kind: string;
  schedule: { cron: string; timezone?: string } | "external";
  /** Worker lane: long kinds never take the slot kept for short ones. */
  lane: DaemonLane;
  /** Makes model calls; refused while no brain-wide daily cap is set. */
  paid: boolean;
  /** A paid daemon's day cap over every source, and its per-run cap (see caps.ts). */
  defaultCapUsdPerDay?: number;
  defaultCapUsdPerRun?: number;
  /** Runs without an operator opting in. */
  defaultEnabled: boolean;
  /** Sources to run for; defaults to the operator's brain only. */
  targets?: (engine: Engine) => Promise<DaemonTarget[]>;
  timeoutMs?: number;
  maxRetries?: number;
  quietHoursSkip?: boolean;
}

/** The operator's brain, the target of a daemon that names no others. */
export const DEFAULT_DAEMON_SOURCE = "default";

const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The maintenance cycle: its own loop and cadence, here for pause and status. */
export const CYCLE_DAEMON: DaemonSpec = {
  name: "cycle",
  kind: "cycle",
  schedule: "external",
  lane: "long",
  paid: false,
  defaultEnabled: true,
};

const BUILTIN: readonly DaemonSpec[] = [CYCLE_DAEMON, CONNECTOR_SYNC_DAEMON];
const registry = new Map<string, DaemonSpec>(BUILTIN.map(d => [d.name, d]));

/** Add a daemon. Throws on a malformed name, cron or zone, or a duplicate. */
export function registerDaemon(spec: DaemonSpec): void {
  if (!NAME_RE.test(spec.name)) throw new Error(`registerDaemon: invalid name '${spec.name}' (lowercase, [a-z0-9_], up to 40)`);
  if (registry.has(spec.name)) throw new Error(`registerDaemon: '${spec.name}' is already registered`);
  if (spec.schedule !== "external") {
    parseCron(spec.schedule.cron);
    if (spec.schedule.timezone !== undefined) assertTimeZone(spec.schedule.timezone);
  }
  registry.set(spec.name, spec);
}

export function listDaemons(): DaemonSpec[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getDaemon(name: string): DaemonSpec | undefined {
  return registry.get(name);
}

/** Job kinds that run in the long lane. */
export function longDaemonKinds(): string[] {
  return listDaemons().filter(d => d.lane === "long" && d.schedule !== "external").map(d => d.kind);
}

/** Test-only: back to the built-in daemons. */
export function _resetDaemonsForTesting(): void {
  registry.clear();
  for (const d of BUILTIN) registry.set(d.name, d);
}
