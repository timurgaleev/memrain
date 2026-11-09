/**
 * `chronicle_extract` job handler — segments one depth page into timeline
 * events OFF the hot write path. Registered at serve startup like the other
 * durable handlers; the worker dispatches by kind.
 *
 * The judge defaults to the paid Sonnet path inside extract-events (omitting
 * `judge` selects it), so this handler spends tokens only when the caller
 * enqueues it. It no-ops cleanly when the page has vanished — runChronicleExtract
 * returns a `skipped/page_not_found` result rather than throwing, so a benign
 * put-then-delete race succeeds instead of dead-lettering.
 */
import type { Storage } from "../storage.ts";
import { registerHandler } from "./handlers.ts";
import {
  runChronicleExtract,
  type ChronicleJudge,
} from "../chronicle/extract-events.ts";
import { chronicleTz } from "../chronicle/config.ts";

import { CHRONICLE_EXTRACT_JOB_KIND } from "./kinds.ts";

export { CHRONICLE_EXTRACT_JOB_KIND };

export interface RegisterChronicleHandlerOpts {
  /** Test seam — inject a stub judge; production omits it to select the paid
   *  Sonnet path inside extract-events. */
  judge?: ChronicleJudge;
}

/**
 * Register the `chronicle_extract` handler. Payload: `{ slug, sourceId }`.
 * The worker races its own wall-clock timeout against the handler, so there is
 * no signal to thread here (neighbouring handlers take none either).
 *
 * Error contract: a TRANSIENT gateway failure (Bedrock throttle/timeout/5xx)
 * thrown by runChronicleExtract propagates out of this handler, so the worker
 * retries the job with backoff rather than recording a false DONE. A PERMANENT
 * failure (missing page, malformed proposals, auth) resolves to a
 * skipped/… result the handler returns normally (job DONE, no retry).
 */
export function registerChronicleHandler(
  storage: Storage,
  opts: RegisterChronicleHandlerOpts = {},
): void {
  registerHandler(CHRONICLE_EXTRACT_JOB_KIND, async (payload) => {
    const slug = typeof payload.slug === "string" ? payload.slug : "";
    if (!slug) throw new Error("chronicle_extract: payload.slug is required");
    const sourceId =
      typeof payload.sourceId === "string" && payload.sourceId.length > 0
        ? payload.sourceId
        : "default";
    const res = await runChronicleExtract(storage, {
      slug,
      sourceId,
      tz: chronicleTz(),
      ...(opts.judge ? { judge: opts.judge } : {}),
    });
    return {
      slug: res.slug,
      status: res.status,
      events_written: res.events_written,
      ...(res.events_retired !== undefined ? { events_retired: res.events_retired } : {}),
      ...(res.reason ? { reason: res.reason } : {}),
    };
  });
}
