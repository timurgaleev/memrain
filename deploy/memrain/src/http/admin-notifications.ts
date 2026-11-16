/**
 * Admin routes for the owner's notifications:
 *
 *   GET  /admin/api/notifications[?all=1]  list (open, or every kept one) + badge counts
 *   GET  /admin/api/notifications/summary  badge counts only
 *   POST /admin/api/notifications/read     {ids: number[]} or {all: true}
 *
 * Dispatched from handleAdminApi after its gates (admin session, same-origin
 * on writes, post-enroll cooldown). Both reads reconcile first, so the list is
 * current without the notifications daemon; the daemon is needed only for the
 * webhook.
 */
import type { Engine } from "../core/engine/interface.ts";
import {
  listNotifications,
  markNotificationsRead,
  notificationSummary,
  syncNotifications,
  type NotificationKind,
} from "../core/notifications/store.ts";
import { loadWebhookConfig } from "../core/notifications/webhook.ts";
import { listAccountStatus } from "../core/connectors/account-status.ts";

const MAX_IDS = 500;
const MAX_BODY = 16 * 1024;

/** What the owner can do about each kind, and where; the detail lives in `memrain doctor`. */
const HINTS: Record<NotificationKind, string> = {
  needs_reconnect: "The connector account lost its authorization. Reconnect it on the Connections page; stored data is kept and sync resumes from its cursor.",
  deletions_held: "A sync run wants to delete more than the mass-delete guard allows. Confirm the held deletions or keep the pages on the Connections page; nothing is deleted until then.",
  items_held: "Some connector items failed repeatedly and are held. See memrain doctor (connector-health) for the cause, then retry them on the Connections page.",
  spend_path_paused: "A paid call cost more than its hold, so its spend path is paused. Check the price table in memrain doctor, then resume the path on the Autonomy page (or: memrain spend resume <path>).",
  daemon_auto_paused: "The daemon failed five runs in a row and was paused. Check its failed jobs, then resume it on the Autonomy page (or: memrain daemons resume <daemon>).",
  write_gate_hold: "Writes from this source read as instructions to an AI and are held out of search. Approve or reject them on the Approvals page (or: memrain write-gate list).",
  oauth_client_rejected: "The provider refused this OAuth app when renewing access: its client secret has expired or is wrong, or the app was deleted. Save a new secret for the same client ID on the Connections page (Use your own OAuth app); the provider's accounts need no reconnect and sync again once it is saved. Until then they try once an hour.",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string) => json({ error }, 400);

async function sync(engine: Engine): Promise<"off" | "refused" | "on"> {
  const load = loadWebhookConfig();
  await syncNotifications(engine, { webhook: load.config !== null });
  return load.config ? "on" : load.configured ? "refused" : "off";
}

function parseIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS) return null;
  return raw.every(v => Number.isSafeInteger(v) && (v as number) > 0) ? (raw as number[]) : null;
}

/**
 * A reconnect that a provider's test-mode grant limit likely caused gets a
 * hint that says so (by account id). No address or token: only the dates.
 */
async function lapsedGrants(engine: Engine, notifications: ReadonlyArray<{ kind: NotificationKind; ref: string; resolved_at: string | null }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!notifications.some(n => n.kind === "needs_reconnect" && n.resolved_at === null)) return out;
  for (const a of await listAccountStatus(engine)) {
    if (a.grant_expiry?.state !== "lapsed") continue;
    out.set(a.id, `Google ends a grant ${a.grant_expiry.days} days after consent while its OAuth app is in Testing, and this one was granted on ${a.grant_expiry.granted_at.slice(0, 10)}. ${HINTS.needs_reconnect} Publish the Google app to stop the weekly expiry.`);
  }
  return out;
}

export async function handleAdminNotifications(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/admin/api/notifications" && req.method === "GET") {
      const webhook = await sync(engine);
      const notifications = await listNotifications(engine, { includeResolved: url.searchParams.get("all") === "1" });
      const lapsed = await lapsedGrants(engine, notifications);
      return json({
        summary: await notificationSummary(engine),
        webhook: { state: webhook },
        notifications: notifications.map(n => ({ ...n, hint: (n.kind === "needs_reconnect" ? lapsed.get(n.ref) : undefined) ?? HINTS[n.kind] })),
      });
    }
    if (p === "/admin/api/notifications/summary" && req.method === "GET") {
      await sync(engine);
      return json(await notificationSummary(engine));
    }
    if (p === "/admin/api/notifications/read" && req.method === "POST") {
      const text = await req.text();
      if (text.length > MAX_BODY) return bad("body too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return bad("invalid JSON body");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("invalid JSON body");
      const b = body as { ids?: unknown; all?: unknown };
      if (b.all === true && b.ids === undefined) return json({ ok: true, marked: await markNotificationsRead(engine, "all") });
      const ids = parseIds(b.ids);
      if (!ids) return bad(`send {"all": true} or {"ids": [...]} with 1 to ${MAX_IDS} positive integer ids`);
      return json({ ok: true, marked: await markNotificationsRead(engine, ids) });
    }
  } catch (e) {
    console.error(`[admin-api] notifications: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "Internal error" }, 500);
  }
  return null;
}
