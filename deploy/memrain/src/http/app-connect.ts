/**
 * Connect a client to the member's brain from /app.
 */
import type { MemberSession } from "../core/member-sessions.ts";
import type { AppDeps } from "./app.ts";

export async function handleAppConnect(_req: Request, url: URL, _session: MemberSession, _deps: AppDeps): Promise<Response | null> {
  if (!url.pathname.startsWith("/app/api/connect")) return null;
  return Response.json({ error: "not_found" }, { status: 404 });
}
