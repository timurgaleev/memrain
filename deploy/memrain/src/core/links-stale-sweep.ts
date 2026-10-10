/**
 * `memrain extract --stale` — incremental link re-extraction sweep.
 *
 * Bumping {@link LINK_EXTRACTOR_VERSION_TS} (or any page edit) marks pages
 * stale; this
 * sweep re-runs the SAME link-sync set the MCP `page_put` path runs
 * (wikilinks + gazetteer mentions + typed-NER + verb-context, each behind its
 * own opt-in gate) over every stale page, then advances the watermark. Without
 * it a version bump is detect-only — the `links-extraction-lag` doctor count
 * rises and only falls as each page is next written.
 *
 * memrain stack notes:
 *  - re-uses memrain's per-page `sync*ForPage` functions (the dispatch put path)
 *    — same edges, one code path. No timeline arm yet: body timeline rows
 *    are derived on write (timeline-body.ts); backfilling pages written
 *    before that is still open.
 *  - keysets on the `slug` PK.
 *  - `engine.query` everywhere ($N), no postgres/pglite branch.
 */
import type { Storage } from "./storage.ts";
import {
  countStalePagesForExtraction,
  listStalePagesForExtraction,
  markPagesExtractedBatch,
  syncWikilinksForPage,
  syncVerbLinksForPage,
  syncCodeRefsForPage,
  LINK_EXTRACTOR_VERSION_TS,
  type ExtractedPageRef,
} from "./links.ts";
import { syncMentionsForPage } from "./gazetteer.ts";
import { syncTypedLinksForPage, typedLinksEnabled } from "./typed-links.ts";
import { linkVerbInferEnabled } from "./link-verb-infer.ts";
import { phaseFenceCheck } from "./cycle/phase-context.ts";

// Keyset batch size. SMALL by design — each row carries full page content
// (markdown_body + compiled_truth), unbounded in size. The LIMIT is the only
// memory bound. Raise via MEMRAIN_EXTRACT_STALE_BATCH for throughput on a brain
// of small pages.
const STALE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.MEMRAIN_EXTRACT_STALE_BATCH) || 50,
);

// Wall-clock budget for one invocation (default 30 min). `--catch-up` removes
// the cap (loops until 0 stale).
const STALE_TIME_BUDGET_MS = Math.max(
  1000,
  Number(process.env.MEMRAIN_EXTRACT_TIME_BUDGET_MS) || 30 * 60 * 1000,
);

export interface ExtractStaleOpts {
  dryRun?: boolean;
  jsonMode?: boolean;
  sourceIds?: string[];
  /** Loop until 0 stale, ignoring the time budget. */
  catchUp?: boolean;
  /** Stop after this many pages (the cycle phase's per-tick cap). */
  maxPages?: number;
  /** Print nothing (the cycle phase reports through its result). */
  quiet?: boolean;
}

export interface ExtractStaleResult {
  pagesProcessed: number;
  linksAdded: number;
  linksRemoved: number;
  staleRemaining: number;
  budgetHit: boolean;
}

/** Re-run the full link-sync set for one page; returns net edge churn. */
async function reExtractPage(
  storage: Storage,
  page: {
    slug: string;
    type: string;
    markdown_body: string;
    compiled_truth: Record<string, unknown> | null;
    source_id: string;
  },
): Promise<{ added: number; removed: number }> {
  const src = page.source_id;
  let added = 0;
  let removed = 0;
  const acc = (r: { added: number; removed: number }) => {
    added += r.added;
    removed += r.removed;
  };
  acc(await syncWikilinksForPage(storage, page.slug, page.markdown_body, src));
  acc(await syncMentionsForPage(storage, page.slug, page.markdown_body, src));
  acc(await syncCodeRefsForPage(storage, page.slug, page.markdown_body, src));
  if (typedLinksEnabled()) {
    acc(
      await syncTypedLinksForPage(
        storage,
        page.slug,
        page.type,
        page.compiled_truth,
        src,
      ),
    );
  }
  if (linkVerbInferEnabled()) {
    acc(
      await syncVerbLinksForPage(
        storage,
        page.slug,
        page.type,
        page.markdown_body,
        src,
      ),
    );
  }
  return { added, removed };
}

export async function extractStaleLinks(
  storage: Storage,
  opts: ExtractStaleOpts = {},
): Promise<ExtractStaleResult> {
  const { dryRun = false, jsonMode = false, sourceIds, catchUp = false, quiet = false } = opts;
  const maxPages =
    typeof opts.maxPages === "number" && opts.maxPages > 0 ? Math.floor(opts.maxPages) : Infinity;
  const engine = storage.engine();

  const totalStale = await countStalePagesForExtraction(engine, { sourceIds });
  if (dryRun) {
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({ action: "extract_stale_dry_run", stale_pages: totalStale }) + "\n",
      );
    } else {
      console.log(
        `(dry run) ${totalStale} page(s) need link re-extraction. Run without --dry-run to extract.`,
      );
    }
    return { pagesProcessed: 0, linksAdded: 0, linksRemoved: 0, staleRemaining: totalStale, budgetHit: false };
  }
  if (totalStale === 0) {
    if (!jsonMode && !quiet) console.log("No stale pages — link extraction is up to date.");
    return { pagesProcessed: 0, linksAdded: 0, linksRemoved: 0, staleRemaining: 0, budgetHit: false };
  }

  const startMs = Date.now();
  let afterSlug: string | undefined;
  let pagesProcessed = 0;
  let linksAdded = 0;
  let linksRemoved = 0;
  let budgetHit = false;

  for (;;) {
    const rows = await listStalePagesForExtraction(engine, {
      batchSize: Math.min(STALE_BATCH_SIZE, maxPages - pagesProcessed),
      afterSlug,
      sourceIds,
    });
    if (rows.length === 0) break;

    const processedRefs: ExtractedPageRef[] = [];
    for (const page of rows) {
      // Inside a cycle phase: stop before the next page's writes once the
      // lock is gone. A no-op from the CLI.
      await phaseFenceCheck();
      const churn = await reExtractPage(storage, page);
      linksAdded += churn.added;
      linksRemoved += churn.removed;
      // Stamp with the row's READ updated_at, not now() (D4 race fix).
      processedRefs.push({
        slug: page.slug,
        source_id: page.source_id,
        extractedAt: page.updated_at_iso,
      });
    }

    // Stamp directly (not the swallowing inline stamp) so a stamp failure
    // surfaces instead of looping forever — the stamp is the resume mechanism.
    // floorTs = the version watermark so a page edited BEFORE the current
    // extractor version still clears the version-staleness arm (see
    // markPagesExtractedBatch); without it the version-bump sweep would never
    // converge and re-extract the whole corpus every run.
    await phaseFenceCheck();
    await markPagesExtractedBatch(
      engine,
      processedRefs,
      new Date().toISOString(),
      LINK_EXTRACTOR_VERSION_TS,
    );

    pagesProcessed += rows.length;
    afterSlug = rows[rows.length - 1]!.slug;

    if (pagesProcessed >= maxPages) {
      budgetHit = true;
      break;
    }
    if (!catchUp && Date.now() - startMs > STALE_TIME_BUDGET_MS) {
      budgetHit = true;
      break;
    }
  }

  const staleRemaining = await countStalePagesForExtraction(engine, { sourceIds });
  const result: ExtractStaleResult = {
    pagesProcessed,
    linksAdded,
    linksRemoved,
    staleRemaining,
    budgetHit,
  };

  if (quiet) return result;
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ action: "extract_stale", ...result }) + "\n");
  } else {
    console.log(
      `Extract --stale: ${linksAdded} link(s) added, ${linksRemoved} removed from ${pagesProcessed} page(s).`,
    );
    if (budgetHit) {
      console.log(
        `Time budget reached — ${staleRemaining} page(s) still stale. Re-run 'memrain extract --stale' (or pass --catch-up) to continue.`,
      );
    } else if (staleRemaining > 0) {
      console.log(
        `WARNING: ${staleRemaining} page(s) still read stale after a full sweep — the stamp may not be clearing the staleness predicate.`,
      );
    }
  }
  return result;
}
