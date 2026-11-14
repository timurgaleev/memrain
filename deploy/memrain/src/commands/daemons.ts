/**
 * `memrain daemons status [--json]`
 * `memrain daemons pause <name|all> [--source ID] [--reason TEXT] [--json]`
 * `memrain daemons resume <name|all> [--source ID] [--json]`
 *
 * Pausing works whether or not a scheduler runs: the maintenance cycle obeys
 * it on its next tick, and a scheduler reads it before queueing anything.
 * Exit codes: 0 done, 1 usage error or refused control.
 */
import { loadConfig } from "../core/config.ts";
import { OperationError } from "../core/operation-error.ts";
import { Storage } from "../core/storage.ts";
import { controlDaemon, daemonsStatus, type DaemonsReport } from "../core/daemons/status.ts";
import { withStorage } from "./with-storage.ts";

export interface DaemonsCmdOptions {
  sub: string | undefined;
  name?: string;
  sourceId?: string;
  reason?: string;
  json?: boolean;
  configPath?: string;
  /** An open Storage owned by the caller. */
  storage?: Storage;
}

function fail(msg: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`memrain daemons: ${msg}`);
  return 1;
}

function printStatus(r: DaemonsReport): void {
  const leader = r.scheduler.leader;
  console.log(
    `scheduler: ${leader ? `leader ${leader.holder}, last tick ${leader.tick_age_s ?? "?"}s ago${leader.live ? "" : " (stale)"}` : "no leader"}` +
      (r.scheduler.enabled_here ? "" : " (MEMRAIN_DAEMONS is not 1 in this shell)"),
  );
  if (r.paused_all) console.log(`ALL DAEMONS PAUSED by ${r.paused_all.by ?? "?"}${r.paused_all.reason ? `: ${r.paused_all.reason}` : ""}`);
  for (const d of r.daemons) {
    const state = d.env_disabled ? "env-disabled" : d.paused ? `paused (${d.paused.by ?? "?"}${d.paused.reason ? `: ${d.paused.reason}` : ""})` : d.enabled ? "enabled" : "disabled";
    const last = d.last_run_at ? `, last run ${d.last_outcome ?? "?"} at ${d.last_run_at}` : d.last_window ? `, last window ${d.last_window}` : "";
    const fails = d.consecutive_failures > 0 ? `, ${d.consecutive_failures} failure(s) in a row` : "";
    const next = d.next_window ? `, next ${d.next_window}` : "";
    console.log(`${d.name} [${d.schedule}, ${d.lane}${d.paid ? ", paid" : ""}]: ${state}${last}${fails}${next}`);
    for (const s of d.sources) {
      console.log(`  ${s.source_id}: ${s.paused ? `paused (${s.paused.by ?? "?"}${s.paused.reason ? `: ${s.paused.reason}` : ""})` : "running"}` +
        (s.last_window ? `, last window ${s.last_window}` : "") +
        (s.consecutive_failures > 0 ? `, ${s.consecutive_failures} failure(s) in a row` : ""));
    }
  }
}

export async function runDaemons(opts: DaemonsCmdOptions): Promise<number> {
  const sub = opts.sub;
  if (sub !== "status" && sub !== "pause" && sub !== "resume") {
    return fail("subcommand required (status | pause <name|all> | resume <name|all>)", opts.json);
  }
  if (sub !== "status" && !opts.name) return fail(`${sub}: a daemon name or 'all' is required`, opts.json);
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (sub === "status") {
      const report = await daemonsStatus(engine);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else printStatus(report);
      return 0;
    }
    try {
      const r = await controlDaemon(engine, {
        action: sub,
        daemon: opts.name,
        ...(opts.sourceId !== undefined ? { source_id: opts.sourceId } : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      }, "cli");
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`${sub}d ${r.daemon}${r.source_id === "*" ? "" : ` for ${r.source_id}`}`);
      return 0;
    } catch (e) {
      if (e instanceof OperationError) return fail(e.message, opts.json);
      throw e;
    }
  }, { owned: opts.storage === undefined });
}
