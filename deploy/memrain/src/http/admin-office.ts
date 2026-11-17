/**
 * Office snapshot: who exists on the live feed when the page opens. Names
 * only: no token hashes, scopes, job payloads, errors or source ids.
 *
 * Dispatched from handleAdminApi after its admin-session gate.
 */
import type { Engine } from "../core/engine/interface.ts";
import { daemonsStatus } from "../core/daemons/status.ts";
import { readControls, resolveControl } from "../core/daemons/controls.ts";
import { cycleDaemonPause } from "../core/daemons/cycle-daemon.ts";
import { getDaemon } from "../core/daemons/registry.ts";
import { targetsOf } from "../core/daemons/scheduler.ts";
import { getHandler } from "../core/jobs/handlers.ts";
import { SUBAGENT_JOB_KIND } from "../core/jobs/kinds.ts";
import { workerNameFor } from "../core/jobs/activity.ts";

export interface OfficeSnapshot {
  workers: { name: string; enabled: boolean; running: boolean }[];
  clients: { id: string; display_name: string; last_seen: string | null }[];
}

// What this process actually started, and whether a maintenance cycle is in
// flight. The cycle runs outside the jobs queue, so neither shows in the DB.
let runtime = { jobsWorker: false, cycleLoop: false };
let cycleRunning = false;

/** Serve calls this once with what really started. */
export function noteOfficeRuntime(r: { jobsWorker: boolean; cycleLoop: boolean }): void {
  runtime = { ...r };
}

export function noteCycleRun(phase: "start" | "end"): void {
  cycleRunning = phase === "start";
}

export function _resetOfficeRuntimeForTesting(): void {
  runtime = { jobsWorker: false, cycleLoop: false };
  cycleRunning = false;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** True when at least one of the daemon's real targets would be queued: enabled and not paused, resolved as the scheduler does. */
async function anyTargetRuns(engine: Engine, name: string, controls: Awaited<ReturnType<typeof readControls>>): Promise<boolean> {
  const spec = getDaemon(name);
  if (!spec) return false;
  let targets;
  try {
    targets = await targetsOf(engine, spec);
  } catch {
    return false;
  }
  return targets.some((t) => {
    const ctl = resolveControl(controls, name, t.sourceId);
    return !ctl.pausedBy && (ctl.enabled ?? spec.defaultEnabled);
  });
}

export async function officeSnapshot(engine: Engine): Promise<OfficeSnapshot> {
  const [report, running, oauth, pats] = await Promise.all([
    daemonsStatus(engine),
    engine.query<{ id: string; kind: string }>("SELECT id, kind FROM jobs WHERE status = 'running'"),
    engine.query<{ client_id: string; client_name: string }>(
      "SELECT client_id, client_name FROM oauth_clients WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500",
    ),
    engine.query<{ name: string; last_seen: string | null }>(
      `SELECT name, max(last_used_at)::text AS last_seen
         FROM access_tokens WHERE revoked_at IS NULL
        GROUP BY name ORDER BY max(last_used_at) DESC NULLS LAST, name LIMIT 500`,
    ),
  ]);
  const busy = new Set(running.rows.map(workerNameFor));
  const controls = await readControls(engine);
  const cycleOpen = (await cycleDaemonPause(engine)) === null;
  const workers = [
    ...(await Promise.all(report.daemons.map(async (d) => {
      // The cycle obeys only a pause, as its own runner does; the enabled
      // switch does not stop it.
      if (d.schedule === "external") {
        return { name: d.name, enabled: runtime.cycleLoop && cycleOpen, running: cycleRunning };
      }
      return {
        name: d.name,
        enabled: report.scheduler.enabled_here && !d.env_disabled && (await anyTargetRuns(engine, d.name, controls)),
        running: busy.has(d.name),
      };
    }))),
    { name: "worker", enabled: runtime.jobsWorker, running: busy.has("worker") },
    ...(getHandler(SUBAGENT_JOB_KIND)
      ? [{ name: "assistant", enabled: runtime.jobsWorker, running: busy.has("assistant") }]
      : []),
  ];
  // A PAT shows up in events under its name (see legacyGrantFromRow), so the
  // name is its id here. First entry per id wins: OAuth clients, then the
  // shared key, then PATs.
  const byId = new Map<string, OfficeSnapshot["clients"][number]>();
  const add = (c: OfficeSnapshot["clients"][number]) => {
    if (!byId.has(c.id)) byId.set(c.id, c);
  };
  for (const c of oauth.rows) add({ id: c.client_id, display_name: c.client_name, last_seen: null });
  add({ id: "public", display_name: "Shared key", last_seen: null });
  for (const t of pats.rows) add({ id: t.name, display_name: t.name, last_seen: t.last_seen });
  return { workers, clients: [...byId.values()] };
}

export async function handleAdminOffice(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  if (url.pathname !== "/admin/api/office" || req.method !== "GET") return null;
  return json(await officeSnapshot(engine));
}
