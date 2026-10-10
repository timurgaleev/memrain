/**
 * `page_mirror` job handler — mirrors a page into the search store OFF the
 * request path, when `MEMRAIN_PAGE_MIRROR_SYNC=0` moves the mirror onto the job
 * queue. The synchronous path (the default) calls the same `mirrorPage`.
 *
 * The handler trusts the page row, not the caller: it re-reads the page, skips
 * one that is gone, and takes the mirror's owner from `pages.source_id` — a job
 * runs with no caller, so nothing else can say whose page it is. The one thing
 * the row cannot say is whether the WRITE came from an untrusted caller, so the
 * payload carries `remote`, and anything but an explicit `false` counts as
 * untrusted: gate-owned frontmatter markers are stripped rather than honoured.
 *
 * A job acts for exactly one write. It reads the page by its exact slug — the
 * rename-redirect registry spans every source, so following it could land on
 * another tenant's page — and it mirrors only the body that write produced:
 * the trust flag describes that write, and applying it to a newer body (a job
 * reordered by retries, say) would honour a tenant's planted markers or strip
 * an operator's. A newer write queues its own job, which carries the right
 * flag, so an older one that finds the body moved on skips as superseded.
 */
import type { Storage } from "../storage.ts";
import { registerHandler } from "./handlers.ts";
import { UnrecoverableJobError } from "./types.ts";
import { getPageExact } from "../pages.ts";
import { mirrorPage, removePageFromSearch } from "../page-index.ts";
import type { IndexFileOptions } from "../indexer.ts";

import { PAGE_MIRROR_JOB_KIND } from "./kinds.ts";

export { PAGE_MIRROR_JOB_KIND };

export interface RegisterPageMirrorHandlerOpts {
  /** Test seams — production omits both. */
  embedFn?: IndexFileOptions["embedFn"];
  contextualLlmFn?: IndexFileOptions["contextualLlmFn"];
}

export function registerPageMirrorHandler(
  storage: Storage,
  opts: RegisterPageMirrorHandlerOpts = {},
): void {
  registerHandler(PAGE_MIRROR_JOB_KIND, async (payload, ctx) => {
    const slug = typeof payload.slug === "string" ? payload.slug : "";
    if (!slug) throw new UnrecoverableJobError("page_mirror: payload.slug is required");
    const remote = payload.remote !== false;
    const page = await getPageExact(storage, slug);
    if (!page) return { slug, status: "skipped", reason: "page_not_found" };
    const contentHash = typeof payload.contentHash === "string" ? payload.contentHash : null;
    if (contentHash !== null && page.content_hash !== contentHash) {
      return { slug, status: "skipped", reason: "superseded" };
    }
    // An abandoned attempt (lost lease, timeout, shutdown) stops before each
    // write: the attempt that re-claimed the row does the mirror instead.
    ctx.signal?.throwIfAborted();
    const lastAttempt = ctx.job.retryCount >= ctx.job.maxRetries;
    const ok = await mirrorPage(storage, page, {
      remote,
      logFailure: lastAttempt,
      timingLabel: typeof payload.op === "string" ? payload.op : "page_mirror",
      ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
      ...(opts.contextualLlmFn ? { contextualLlmFn: opts.contextualLlmFn } : {}),
    });
    // A failed mirror throws so the worker retries it with backoff; the
    // operator's failure row is written only on the last attempt.
    if (!ok) throw new Error(`page_mirror: mirroring ${slug} failed`);
    ctx.signal?.throwIfAborted();
    // A delete that landed while this job was embedding has already removed the
    // mirror — and this job just wrote it back. Take it out again, or a deleted
    // page answers searches until the cycle's orphan sweep.
    if (!(await getPageExact(storage, slug))) {
      await removePageFromSearch(storage, slug, page.source_id);
      return { slug, status: "skipped", reason: "deleted_while_mirroring" };
    }
    return { slug, status: "mirrored" };
  });
}
