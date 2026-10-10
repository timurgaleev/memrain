/**
 * links-stale phase — re-extracts the links of pages that read stale for
 * extraction, a capped batch per tick.
 *
 * A page goes stale when it was never extracted, was edited since, or was
 * extracted before the effective watermark: the code's extractor version or
 * the last change of the extractor switches (link-watermark.ts), which this
 * phase records first. Without it a version bump or a switch change only
 * showed as doctor lag until each page happened to be written again.
 *
 * MEMRAIN_LINKS_STALE_MAX_PER_CYCLE caps the pages per tick (default 200,
 * 0 turns the phase off). The sweep checks the cycle fence before each page
 * and before stamping, so a run whose lock was taken stops writing.
 */
import type { Storage } from "../storage.ts";
import { extractStaleLinks } from "../links-stale-sweep.ts";
import { LINK_EXTRACTOR_VERSION_TS } from "../links.ts";
import { syncLinkFlagsGeneration } from "../link-watermark.ts";
import { phaseFenceCheck } from "./phase-context.ts";

const DEFAULT_MAX_PER_CYCLE = 200;

export interface LinksStaleResult {
  ran: boolean;
  reason?: string;
  /** The extractor switches changed since the last record: every page is stale once. */
  flagsChanged: boolean;
  pagesProcessed: number;
  linksAdded: number;
  linksRemoved: number;
  staleRemaining: number;
  /** The per-tick cap stopped the sweep with stale pages left. */
  capHit: boolean;
}

export function linksStaleMaxPerCycle(
  env: string | undefined = process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE,
): number {
  const raw = env?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_PER_CYCLE;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_PER_CYCLE;
}

export async function linksStalePhase(
  storage: Storage,
  opts: { maxPages?: number } = {},
): Promise<LinksStaleResult> {
  const max = opts.maxPages ?? linksStaleMaxPerCycle();
  const idle = { flagsChanged: false, pagesProcessed: 0, linksAdded: 0, linksRemoved: 0, staleRemaining: 0, capHit: false };
  if (max <= 0) return { ran: false, reason: "disabled", ...idle };
  await phaseFenceCheck();
  const { changed } = await syncLinkFlagsGeneration(storage.engine(), LINK_EXTRACTOR_VERSION_TS);
  const r = await extractStaleLinks(storage, { maxPages: max, quiet: true });
  return {
    ran: true,
    flagsChanged: changed,
    pagesProcessed: r.pagesProcessed,
    linksAdded: r.linksAdded,
    linksRemoved: r.linksRemoved,
    staleRemaining: r.staleRemaining,
    capHit: r.budgetHit && r.staleRemaining > 0,
  };
}
