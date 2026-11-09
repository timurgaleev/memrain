/**
 * Cycle phase — page → search mirror reconciliation.
 *
 * The write path (page_put/page_append) mirrors a page into the search store
 * synchronously, but that embed is best-effort: a transient Bedrock failure
 * leaves a page written-but-unsearchable. This phase is the backstop — it
 * re-mirrors missing/stale page documents and drops orphan mirrors. Needs a
 * Storage handle (it embeds + reads the pages table), so it no-ops on an
 * engine-only harness, mirroring how `extract-timeline` degrades.
 */
import type { Storage } from "../storage.ts";
import { retireDeletedSourceEvents } from "../chronicle/retire-events.ts";
import {
  reconcilePageMirrors,
  type ReconcilePageMirrorsResult,
} from "../page-index.ts";

export type MirrorPagesResult = ReconcilePageMirrorsResult & { retired_events?: number };

export interface MirrorPagesOptions {
  /** Cap pages reconciled per run (drains a backlog over several cycles). */
  maxPerRun?: number;
}

export async function mirrorPagesPhase(
  storage: Storage,
  opts: MirrorPagesOptions = {},
): Promise<MirrorPagesResult> {
  const o: Parameters<typeof reconcilePageMirrors>[1] = {};
  if (opts.maxPerRun !== undefined) o.maxPerRun = opts.maxPerRun;
  const retired = await retireDeletedSourceEvents(storage);
  const result = await reconcilePageMirrors(storage, o);
  return { ...result, ...(retired ? { retired_events: retired } : {}) };
}
