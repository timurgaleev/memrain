/**
 * Admin routes for the write gate's hold queues (the Approvals page): list the
 * documents the gate held and approve or reject one; list the facts, takes and
 * timeline entries it held and release or drop one.
 *
 * Dispatched from handleAdminApi after its gates (admin session, same-origin
 * on writes, post-enroll cooldown). A hold's excerpt is outside text: it goes
 * back as data for the page to show as plain text, never as markup.
 */
import type { Storage } from "../core/storage.ts";
import { decideWriteGateHold, listWriteGateHolds, type WriteGateDecisionStatus } from "../core/write-gate-holds.ts";
import { dropRowHold, listRowHolds, releaseRowHold, type RowHoldDecisionStatus } from "../core/write-gate-row-holds.ts";

const DECIDED_BY = "admin";
const STATUS_HTTP: Record<WriteGateDecisionStatus, number> = {
  approved: 200,
  rejected: 200,
  stale: 200,
  already_decided: 409,
  not_found: 404,
};

const ROW_STATUS_HTTP: Record<RowHoldDecisionStatus, number> = {
  released: 200,
  dropped: 200,
  already_decided: 409,
  not_found: 404,
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleAdminApprovals(req: Request, url: URL, storage: Storage): Promise<Response | null> {
  const engine = storage.engine();
  const p = url.pathname;
  if (p === "/admin/api/write-gate/holds" && req.method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    if (status !== "open" && status !== "all") return json({ error: "status must be open or all" }, 400);
    return json({ holds: await listWriteGateHolds(engine, { status }) });
  }

  if (p === "/admin/api/write-gate/rows" && req.method === "GET") {
    const status = url.searchParams.get("status") ?? "held";
    if (status !== "held" && status !== "all") return json({ error: "status must be held or all" }, 400);
    return json({ holds: await listRowHolds(engine, { status }) });
  }
  const row = /^\/admin\/api\/write-gate\/rows\/([^/]+)\/decide$/.exec(p);
  if (row && req.method === "POST") {
    const id = Number(row[1]);
    if (!/^\d{1,15}$/.test(row[1]!) || !Number.isSafeInteger(id)) return json({ error: "invalid hold id" }, 400);
    let decision: unknown;
    try {
      decision = ((await req.json()) as { decision?: unknown } | null)?.decision;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (decision !== "release" && decision !== "drop") return json({ error: "decision must be release or drop" }, 400);
    const r = decision === "release" ? await releaseRowHold(storage, id, DECIDED_BY) : await dropRowHold(engine, id, DECIDED_BY);
    return json(r, ROW_STATUS_HTTP[r.status]);
  }

  const m = /^\/admin\/api\/write-gate\/holds\/([^/]+)\/decide$/.exec(p);
  if (!m || req.method !== "POST") return null;
  const holdId = Number(m[1]);
  if (!/^\d{1,15}$/.test(m[1]!) || !Number.isSafeInteger(holdId)) return json({ error: "invalid hold id" }, 400);
  let decision: unknown;
  try {
    decision = ((await req.json()) as { decision?: unknown } | null)?.decision;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (decision !== "approve" && decision !== "reject") return json({ error: "decision must be approve or reject" }, 400);
  const r = await decideWriteGateHold(engine, { holdId, decision, decidedBy: DECIDED_BY });
  return json(r, STATUS_HTTP[r.status]);
}
