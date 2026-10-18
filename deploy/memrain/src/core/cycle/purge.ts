/**
 * purge phase — hard-deletes content that has aged past the soft-delete TTL,
 * and prunes telemetry tables (volunteer events, write requests, request log).
 *
 * Soft-delete (documents + pages) and archive (documents) are reversible column
 * flips; this phase is the reaper that finally frees the row once it's older
 * than `SOFT_DELETE_TTL_HOURS`. Set-based, cascades to chunks/embeddings/links
 * via FK. Idempotent: a run with nothing expired is a no-op.
 */
import type { Engine } from "../engine/interface.ts";
import {
  purgeExpiredDocuments,
  SOFT_DELETE_TTL_HOURS,
} from "../destructive-guard.ts";
import { purgeStaleVolunteerEvents } from "../context/volunteer-events.ts";
import { purgeDeletedPages } from "../pages-purge.ts";
import { purgeExpiredWriteRequests } from "../write-requests.ts";
import { purgeRequestLog } from "../request-log-retention.ts";
import { phaseFenceCheck, PhaseStoppedError } from "./phase-context.ts";

export interface PurgeResult {
  purged_documents_deleted: number;
  purged_documents_archived: number;
  purged_pages: number;
  /** Expired pages left in place because a non-cascading row still references them. */
  blocked_pages: number;
  purged_volunteer_events: number;
  /** request_id records past their replay window. */
  purged_write_requests: number;
  /** mcp_request_log rows past MEMRAIN_REQUEST_LOG_RETENTION_DAYS. */
  purged_request_log: number;
  /** The run hit its batch cap; the rest goes next cycle. */
  request_log_capped: boolean;
  /** Retention failures; a non-empty list marks the phase warn. */
  errors: string[];
}

export async function purgePhase(
  engine: Engine,
  opts: { ttlHours?: number } = {},
): Promise<PurgeResult> {
  const ttlHours = opts.ttlHours ?? SOFT_DELETE_TTL_HOURS;
  await phaseFenceCheck();
  const docs = await purgeExpiredDocuments(engine, ttlHours);
  // Pages purge: a page soft-deleted past the TTL is hard-removed. Its search
  // mirror (page://<slug> document) was already dropped on soft-delete, so this
  // only reaps the canonical row + its version chain (FK cascade).
  await phaseFenceCheck();
  const p = await purgeDeletedPages(engine, ttlHours);
  // Telemetry GC: prune volunteer-context feedback events past their TTL.
  // Best-effort (the helper swallows its own errors), never blocks the reaper.
  await phaseFenceCheck();
  const purged_volunteer_events = await purgeStaleVolunteerEvents(engine);
  await phaseFenceCheck();
  const purged_write_requests = await purgeExpiredWriteRequests(engine);
  // Request-log retention. A fence stop must leave the phase, not become an
  // error entry that lets the loop keep deleting under a lost lock.
  const errors: string[] = [];
  let rl = { deleted: 0, capped: false };
  await phaseFenceCheck();
  try {
    rl = await purgeRequestLog(engine, { between: phaseFenceCheck });
  } catch (e) {
    if (e instanceof PhaseStoppedError) throw e;
    errors.push(`request_log: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    purged_documents_deleted: docs.purged_deleted,
    purged_documents_archived: docs.purged_archived,
    purged_pages: p.count,
    blocked_pages: p.blocked.length,
    purged_volunteer_events,
    purged_write_requests,
    purged_request_log: rl.deleted,
    request_log_capped: rl.capped,
    errors,
  };
}
