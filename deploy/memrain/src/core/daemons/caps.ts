/**
 * A paid daemon's spend caps, and the wallet path its runs are made under.
 *
 * Caps, each a ceiling (the brain-wide MEMRAIN_DAILY_BUDGET_USD binds first
 * whenever it is lower):
 *   day, every source  MEMRAIN_DAEMON_<NAME>_MAX_USD_PER_DAY, else the spec's
 *                      default; a daemon_controls row (name, '*') may lower it
 *   day, one source    daemon_controls row (name, source).cap_usd_per_day
 *   one run            MEMRAIN_DAEMON_<NAME>_MAX_USD_PER_RUN, else the spec's
 *                      default; either control row may lower it
 * A control row never raises a cap: it is the knob a tenant or an operator
 * turns down without editing the environment.
 */
import type { Engine } from "../engine/interface.ts";
import type { WalletPath } from "../budget.ts";
import type { DaemonSpec } from "./registry.ts";

export interface DaemonCaps {
  dayCapUsd: number | null;
  sourceDayCapUsd: number | null;
  runCapUsd: number | null;
}

function envUsd(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rowUsd(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The smallest of the caps that are set; null when none is. */
function lowest(...caps: (number | null)[]): number | null {
  const set = caps.filter((c): c is number => c !== null);
  return set.length === 0 ? null : Math.min(...set);
}

function envName(daemon: string, what: "DAY" | "RUN"): string {
  return `MEMRAIN_DAEMON_${daemon.toUpperCase()}_MAX_USD_PER_${what}`;
}

export async function resolveDaemonCaps(
  engine: Engine,
  spec: DaemonSpec,
  sourceId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DaemonCaps> {
  // scope: operator-only caps are operator controls for one daemon, read by its own run
  const r = await engine.query<{ source_id: string; cap_usd_per_day: string | number | null; cap_usd_per_run: string | number | null }>(
    `SELECT source_id, cap_usd_per_day, cap_usd_per_run FROM daemon_controls
      WHERE daemon = $1 AND source_id IN ('*', $2)`,
    [spec.name, sourceId],
  );
  const wide = r.rows.find((row) => row.source_id === "*");
  const exact = sourceId === "*" ? undefined : r.rows.find((row) => row.source_id === sourceId);
  const baseDay = envUsd(env, envName(spec.name, "DAY")) ?? spec.defaultCapUsdPerDay ?? null;
  const baseRun = envUsd(env, envName(spec.name, "RUN")) ?? spec.defaultCapUsdPerRun ?? null;
  return {
    dayCapUsd: lowest(baseDay, rowUsd(wide?.cap_usd_per_day)),
    sourceDayCapUsd: rowUsd(exact?.cap_usd_per_day),
    runCapUsd: lowest(baseRun, rowUsd(wide?.cap_usd_per_run), rowUsd(exact?.cap_usd_per_run)),
  };
}

/** The wallet path one paid daemon run for `sourceId` is made under. */
export async function daemonWalletPath(
  engine: Engine,
  spec: DaemonSpec,
  sourceId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WalletPath> {
  const caps = await resolveDaemonCaps(engine, spec, sourceId, env);
  return {
    role: spec.name,
    requiresBrainCap: true,
    ...(caps.runCapUsd !== null ? { runCapUsd: caps.runCapUsd } : {}),
    daemon: { name: spec.name, sourceId, dayCapUsd: caps.dayCapUsd, sourceDayCapUsd: caps.sourceDayCapUsd },
  };
}
