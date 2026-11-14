/**
 * Doctor check for owner notifications: what is open right now, by kind, and
 * whether the webhook is set up and keeping up. Read-only — it derives the
 * open problems instead of reconciling them — and warn-only.
 */
import type { Engine } from "../engine/interface.ts";
import type { OpsCheckResult } from "../doctor-ops.ts";
import { currentProblems, type NotificationKind } from "./store.ts";
import { loadWebhookConfig } from "./webhook.ts";

/** A due delivery older than this means nothing is draining the outbox. */
const STALE_PENDING_MS = 3_600_000;
const FAILED_WINDOW_MS = 7 * 86_400_000;

export interface NotificationsCheckOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export async function checkNotifications(engine: Engine, opts: NotificationsCheckOptions = {}): Promise<OpsCheckResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const problems = await currentProblems(engine);
  const byKind = new Map<NotificationKind, number>();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  const parts: string[] = [];
  const warnings: string[] = [];
  if (problems.length > 0) {
    const kinds = [...byKind.entries()].sort().map(([k, n]) => `${k} ${n}`).join(", ");
    warnings.push(`${problems.length} open (${kinds}); see /admin#notifications`);
  } else {
    parts.push("nothing open");
  }

  const load = loadWebhookConfig(env);
  if (!load.configured) {
    parts.push("webhook off");
  } else if (!load.config) {
    warnings.push(`webhook refused: ${load.reason}`);
  } else {
    parts.push("webhook on");
    // scope: operator-only the operator's webhook outbox covers every source
    const r = await engine.query<{ stale: number | string; failed: number | string; last_error: string | null }>(
      `SELECT count(*) FILTER (WHERE webhook_state = 'pending' AND webhook_next_at < $1)::int AS stale,
              count(*) FILTER (WHERE webhook_state = 'failed' AND created_at > $2)::int AS failed,
              (SELECT webhook_error FROM notifications WHERE webhook_state = 'failed'
                ORDER BY created_at DESC, id DESC LIMIT 1) AS last_error
         FROM notifications`,
      [new Date(now.getTime() - STALE_PENDING_MS).toISOString(), new Date(now.getTime() - FAILED_WINDOW_MS).toISOString()],
    );
    const stale = Number(r.rows[0]?.stale ?? 0);
    const failed = Number(r.rows[0]?.failed ?? 0);
    if (stale > 0) {
      warnings.push(`${stale} webhook delivery waiting over an hour; is the daemon on? memrain daemons enable notifications (needs MEMRAIN_DAEMONS=1)`);
    }
    if (failed > 0) warnings.push(`${failed} webhook delivery failed (last error ${r.rows[0]?.last_error ?? "unknown"}) in the last 7 days`);
  }
  if (warnings.length === 0) return { ok: true, status: "ok", detail: parts.join("; ") };
  return { ok: true, status: "warn", detail: [...warnings, ...parts].join("; ") };
}
