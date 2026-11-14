/**
 * `notifications` as a scheduled daemon: every 5 minutes, reconcile the owner's
 * notifications with the problems open now, send the webhook for those due,
 * and purge resolved ones past retention. It makes no model call.
 *
 * Off by default (`defaultEnabled: false`, and the scheduler itself needs
 * MEMRAIN_DAEMONS=1). The admin list reconciles on read, so in-product
 * notifications do not need the daemon; only the webhook does.
 */
import type { DaemonSpec } from "../daemons/registry.ts";

export const NOTIFICATIONS_JOB_KIND = "notifications";

export const NOTIFICATIONS_DAEMON: DaemonSpec = {
  name: "notifications",
  kind: NOTIFICATIONS_JOB_KIND,
  schedule: { cron: "*/5 * * * *" },
  lane: "short",
  paid: false,
  defaultEnabled: false,
  // Twenty deliveries at the 10 s webhook timeout, with room to spare.
  timeoutMs: 5 * 60_000,
  // A failed run is retried by the next window; each webhook has its own retries.
  maxRetries: 0,
};
