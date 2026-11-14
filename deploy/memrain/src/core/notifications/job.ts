/**
 * One run of the `notifications` daemon, and its job handler behind the
 * scheduler's gate (MEMRAIN_DAEMONS, pauses, the daemon's enabled switch).
 */
import type { Engine } from "../engine/interface.ts";
import type { FetchFn } from "../connectors/client.ts";
import { registerDaemonHandler } from "../daemons/scheduler.ts";
import { NOTIFICATIONS_DAEMON } from "./daemon.ts";
import { notificationRetentionDays, purgeResolvedNotifications, syncNotifications, type SyncResult } from "./store.ts";
import { deliverPendingWebhooks, loadWebhookConfig, type DeliveryResult } from "./webhook.ts";

export interface NotificationsRunOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
  now?: Date;
}

export interface NotificationsRun {
  /** off: no webhook set; refused: set but unusable (doctor says why); on: delivering. */
  webhook: "off" | "refused" | "on";
  sync: SyncResult;
  delivery: DeliveryResult | null;
  purged: number;
}

export async function runNotifications(engine: Engine, opts: NotificationsRunOptions = {}): Promise<NotificationsRun> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const load = loadWebhookConfig(env);
  const sync = await syncNotifications(engine, { webhook: load.config !== null, now });
  const delivery = load.config
    ? await deliverPendingWebhooks(engine, load.config, {
        now,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(env.MEMRAIN_PUBLIC_URL ? { publicUrl: env.MEMRAIN_PUBLIC_URL } : {}),
      })
    : null;
  const purged = await purgeResolvedNotifications(engine, now, notificationRetentionDays(env));
  return { webhook: load.config ? "on" : load.configured ? "refused" : "off", sync, delivery, purged };
}

/** Accept the `notifications` kind in this process; serve calls this at boot. */
export function registerNotificationsDaemon(engine: Engine, opts: { env?: NodeJS.ProcessEnv; fetch?: FetchFn } = {}): void {
  registerDaemonHandler(engine, NOTIFICATIONS_DAEMON, async () => ({ ...await runNotifications(engine, opts) }), {
    ...(opts.env ? { env: opts.env } : {}),
  });
}
