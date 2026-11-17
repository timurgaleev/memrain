/**
 * Office snapshot: who exists on the live feed when the page opens. Names
 * only: no token hashes, scopes, job payloads, errors or source ids.
 *
 * Dispatched from handleAdminApi after its admin-session gate.
 */
import type { Engine } from "../core/engine/interface.ts";
import { daemonsStatus } from "../core/daemons/status.ts";
import { getHandler } from "../core/jobs/handlers.ts";
import { SUBAGENT_JOB_KIND } from "../core/jobs/kinds.ts";
import { workerNameFor } from "../core/jobs/activity.ts";

export interface OfficeSnapshot {
  workers: { name: string; enabled: boolean; running: boolean }[];
  clients: { id: string; display_name: string; last_seen: string | null }[];
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function officeSnapshot(engine: Engine): Promise<OfficeSnapshot> {
  const [report, running, oauth, pats] = await Promise.all([
    daemonsStatus(engine),
    engine.query<{ id: string; kind: string }>("SELECT id, kind FROM jobs WHERE status = 'running'"),
    engine.query<{ client_id: string; client_name: string }>(
      "SELECT client_id, client_name FROM oauth_clients WHERE deleted_at IS NULL ORDER BY client_name",
    ),
    engine.query<{ name: string; last_seen: string | null }>(
      `SELECT name, max(last_used_at)::text AS last_seen
         FROM access_tokens WHERE revoked_at IS NULL GROUP BY name ORDER BY name`,
    ),
  ]);
  const busy = new Set(running.rows.map(workerNameFor));
  const workers = [
    ...report.daemons.map((d) => ({ name: d.name, enabled: d.enabled, running: busy.has(d.name) })),
    { name: "worker", enabled: true, running: busy.has("worker") },
    ...(getHandler(SUBAGENT_JOB_KIND) ? [{ name: "assistant", enabled: true, running: busy.has("assistant") }] : []),
  ];
  // A PAT shows up in events under its name (see legacyGrantFromRow), so the
  // name is its id here.
  const clients = [
    ...oauth.rows.map((c) => ({ id: c.client_id, display_name: c.client_name, last_seen: null })),
    ...pats.rows.map((t) => ({ id: t.name, display_name: t.name, last_seen: t.last_seen })),
    { id: "public", display_name: "Shared key", last_seen: null },
  ];
  return { workers, clients };
}

export async function handleAdminOffice(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  if (url.pathname !== "/admin/api/office" || req.method !== "GET") return null;
  return json(await officeSnapshot(engine));
}
