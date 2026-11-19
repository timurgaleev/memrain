/**
 * Admin routes for the spend wallet's paused paths (the Autonomy page): a paid
 * path whose call cost more than the maximum held for it stays paused until
 * the owner resumes it (= `memrain spend resume <path>`).
 *
 * Dispatched from handleAdminApi after its gates (admin session, same-origin
 * on writes, post-enroll cooldown). The daemon routes live in admin-api.ts.
 */
import type { Engine } from "../core/engine/interface.ts";
import { pausedSpendPaths, resumeSpendPath } from "../core/budget.ts";

const RESUMED_BY = "admin";
const MAX_PATH = 200;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleAdminAutonomy(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/admin/api/spend/paused" && req.method === "GET") {
    return json({ paths: await pausedSpendPaths(engine) });
  }
  if (p !== "/admin/api/spend/resume" || req.method !== "POST") return null;
  let path: unknown;
  try {
    path = ((await req.json()) as { path?: unknown } | null)?.path;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (typeof path !== "string" || path.trim() === "" || path.length > MAX_PATH) {
    return json({ error: `path must be a paused path name of at most ${MAX_PATH} characters` }, 400);
  }
  return json({ ok: true, resumed: await resumeSpendPath(engine, path, RESUMED_BY) });
}
