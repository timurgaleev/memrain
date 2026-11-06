/**
 * Vault sweep — walk a directory recursively, look at every `.md` file,
 * compare on-disk mtime to documents.last_indexed_mtime, and re-index
 * the ones that are new or stale.
 *
 * The walk is intentionally synchronous (readdirSync) — vault size is
 * O(thousands), not O(millions), and async iteration just adds overhead
 * for negligible parallelism gains given the embed roundtrips dominate.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Storage } from "./storage.ts";
import { indexFile, normalizeSourcePath } from "./indexer.ts";
import { walkFiles } from "./walk.ts";
import { listStaleChunkerDocIds } from "./chunker-version.ts";
import { reconcileDeletedDocuments } from "./reconcile-deletes.ts";
import { backfillDocumentSources, loadRereadGuard, type StoredDocument } from "./sources.ts";
import { LEGACY_VAULT_IGNORES } from "./brand.ts";

export interface SweepOptions {
  /** Filesystem root of the vault. */
  vault: string;
  /** Globs to skip (literal-matched against the relative path). Defaults
   *  cover editor/tooling dotfile dirs + the memrain data dir. */
  ignore?: string[];
  /** When true, re-index every file regardless of mtime. */
  force?: boolean;
  /**
   * Sleep this many ms between consecutive file indexes. Defaults to 0
   * (no delay). Useful as a safety knob on tiny instances where the
   * cumulative working set of PGLite + Bun JIT + chokidar + in-flight
   * Titan responses can OOM the host (caught on t4g.small / 2 GB). At
   * ~50 ms the sweep paces ~20 docs/sec, which is well below
   * Bedrock's regional Titan TPM/RPM ceilings.
   */
  perFileDelayMs?: number;
  /**
   * Stop after this many *re-indexes* (skipped files don't count).
   * Defaults to unlimited. Useful for smoke runs ("just chew through
   * 50 docs to test") without committing to the whole vault.
   */
  maxFiles?: number;
  /**
   * Force-reindex documents whose stamped `chunker_version` is below the
   * current value for their kind (migration 052), even when mtime is
   * unchanged — the targeted half of `reindex --rechunk-stale`. Re-chunks +
   * re-embeds only the stale set, not the whole corpus (which `force` would).
   */
  forceStaleChunker?: boolean;
  /**
   * Deletion-reconcile (opt-in, default OFF): after the walk, soft-delete the
   * DB documents under this vault root whose file has been removed from disk,
   * so a deleted note stops surfacing as stale evidence. OFF by default because
   * an mtime-incremental sweep over a PARTIAL file set must never delete docs
   * outside that set — see the guard at the call site. Scope is the full
   * `opts.vault` root; only run on a COMPLETE walk (skipped on a `maxFiles`
   * break, which leaves later files unwalked and would look "missing").
   */
  reconcileDeletes?: boolean;
  /** Let the reconcile retire more than 50, or more than 25%, of the live documents. */
  allowMassDelete?: boolean;
}

export interface SweepResult {
  scanned: number;
  reindexed: number;
  skipped: number;
  errors: { path: string; message: string }[];
  /**
   * Canonical paths the re-read guard would not read into their stored row
   * (outside the roots, or a row another source or a remote `index` owns).
   * The walk leaves them unindexed; reclaiming one is an operator decision.
   */
  refused: string[];
  /**
   * `forceStaleChunker` only: ids of chunker-stale documents that the walk never
   * reached (file deleted/moved from the vault, under an ignored dir, or indexed
   * from a path outside this vault root). They stay stale until their file
   * reappears or they are purged — surfaced here so the run signals the gap
   * instead of silently reporting success.
   */
  staleChunkerUnreached?: string[];
  /**
   * `reconcileDeletes` only: number of documents soft-deleted because their
   * file was removed from the vault since the last index.
   */
  reconciled?: number;
  /** `reconcileDeletes` only: the source_paths retired by the reconcile pass. */
  reconciledPaths?: string[];
}

const DEFAULT_IGNORES = [
  ".obsidian",
  ".trash",
  ".git",
  "memrain",
  ".memrain",
  ...LEGACY_VAULT_IGNORES,
  "node_modules",
];

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

// File walking lives in core/walk.ts so the markdown sweep and the
// code sweep (sweep-code.ts) share one implementation.

/**
 * Walk the vault, compare mtime against documents.last_indexed_mtime,
 * re-index changed files. Returns a small summary suitable for logging.
 */
export async function sweepVault(
  storage: Storage,
  opts: SweepOptions,
): Promise<SweepResult> {
  const ignore = new Set([...(opts.ignore ?? []), ...DEFAULT_IGNORES]);
  const result: SweepResult = {
    scanned: 0,
    reindexed: 0,
    skipped: 0,
    errors: [],
    refused: [],
  };

  // walkFiles yields nothing for a missing root, which would read as a clean
  // empty sweep — and to a reconcile, as "every document was deleted".
  if (!existsSync(opts.vault) || !statSync(opts.vault).isDirectory()) {
    result.errors.push({ path: opts.vault, message: "vault root is not a readable directory" });
    return result;
  }

  // Pull all known last_indexed_mtime in one shot — vault is small enough
  // that this is much cheaper than per-file SELECT.
  const known = new Map<string, StoredDocument>();
  const rows = await storage
    .raw()
    .query<{ id: string; source_id: string | null; last_indexed_mtime: number | null }>(
      "SELECT id, source_id, last_indexed_mtime FROM documents",
    );
  for (const r of rows.rows) {
    known.set(r.id, { sourceId: r.source_id, lastIndexedMtime: r.last_indexed_mtime });
  }
  const mayReread = await loadRereadGuard(storage.raw(), [opts.vault]);

  // Targeted re-chunk: the ids whose chunks predate the current chunker
  // version. A walked file in this set is re-indexed regardless of mtime.
  // Markdown-only: this walk sees `.md` files, so a stale CODE doc could never
  // be reached here and would land in `staleChunkerUnreached` as a phantom.
  const staleChunkerIds = opts.forceStaleChunker
    ? await listStaleChunkerDocIds(storage.raw(), "markdown")
    : null;
  const seenStaleIds = staleChunkerIds ? new Set<string>() : null;

  const perFileDelayMs = Math.max(0, opts.perFileDelayMs ?? 0);
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  let budgetBroke = false;
  // Paths this walk CONFIRMED as local: either it indexed the file, or it
  // skipped the file because the row already carried a newer index of it. That
  // is the provenance fence for the source classification below — a path the
  // walk merely saw proves nothing about who wrote the row sitting at it.
  const indexed: string[] = [];

  for (const file of walkFiles(opts.vault, {
    extensions: [".md"],
    ignore,
  })) {
    result.scanned++;
    // Must match the id indexFile will WRITE, not the shape the walker yields.
    // With a relative --vault root the two diverge, and the mtime skip then
    // misses on every file: no corruption, but every sweep re-embeds the whole
    // vault and the skip silently stops being a skip.
    const canonical = normalizeSourcePath(file.path);
    const id = docId(canonical);
    const stored = known.get(id) ?? null;
    // A remote `index` may have labelled a row with this path first; indexFile
    // keeps the row's owner, so reading the file into it would hand the file
    // to whoever wrote the label.
    const verdict = mayReread(canonical, stored);
    if (!verdict.ok) {
      console.warn(`[sweep] not indexing ${canonical}: ${verdict.reason}`);
      result.refused.push(verdict.canonical);
      continue;
    }
    const lastIndexed = stored?.lastIndexedMtime ?? null;
    const forcedByChunker = staleChunkerIds?.has(id) ?? false;
    if (forcedByChunker) seenStaleIds!.add(id);
    if (
      !opts.force &&
      !forcedByChunker &&
      lastIndexed !== null &&
      lastIndexed >= file.mtimeMs
    ) {
      result.skipped++;
      indexed.push(canonical);
      continue;
    }
    if (result.reindexed >= maxFiles) {
      // Budget exhausted — stop walking. Subsequent scans will pick up where
      // we left off (since last_indexed_mtime gets written on each success).
      budgetBroke = true;
      break;
    }
    try {
      // The verdict above is against `known`, a snapshot from the start of
      // the walk; indexFile judges the row again as it stands now.
      await indexFile(storage, file.path, { rereadGuard: mayReread });
      result.reindexed++;
      indexed.push(canonical);
    } catch (e) {
      result.errors.push({
        path: file.path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (perFileDelayMs > 0) {
      await new Promise((res) => setTimeout(res, perFileDelayMs));
    }
  }

  // Only meaningful on a COMPLETE walk: a maxFiles break leaves later stale
  // files unwalked-but-not-orphaned (they resume next run), so don't flag them.
  if (staleChunkerIds && seenStaleIds && !budgetBroke) {
    const unreached = [...staleChunkerIds].filter((id) => !seenStaleIds.has(id));
    if (unreached.length > 0) result.staleChunkerUnreached = unreached;
  }

  // Deletion-reconcile: retire docs whose file vanished from THIS vault root.
  // Only on a COMPLETE walk — a `maxFiles` break leaves later files unwalked,
  // and reconcile keys off on-disk existence within `opts.vault`, so a
  // truncated run must not run it (a not-yet-walked file still exists on disk
  // and would survive anyway, but skipping keeps the "partial ⇒ no reconcile"
  // rule explicit and single-sourced).
  if (opts.reconcileDeletes && !budgetBroke && result.scanned === 0) {
    result.errors.push({
      path: opts.vault,
      message: "walk found no files; skipping the deletion reconcile",
    });
  } else if (opts.reconcileDeletes && !budgetBroke) {
    // The root must be canonicalized the same way the rows were: documents now
    // store an absolute source_path, and reconcile decides membership with a
    // prefix test. Handing it the raw `notes` while the rows say
    // `/cwd/notes/a.md` matches nothing, so a deleted file would never be
    // soft-deleted and its chunks would keep answering searches.
    const rec = await reconcileDeletedDocuments(
      storage.raw(),
      normalizeSourcePath(opts.vault),
      { allowMassDelete: opts.allowMassDelete ?? false },
    );
    result.reconciled = rec.reconciled;
    result.reconciledPaths = rec.reconciledPaths;
  }

  // indexFile writes no source (a trusted local caller must not be fenced from
  // rows another source owns), so the registered path prefixes classify the
  // walked files afterwards. A failure here leaves the walk's own result
  // standing — the next sweep retries the classification.
  try {
    await backfillDocumentSources(storage.raw(), indexed);
  } catch (e) {
    result.errors.push({
      path: opts.vault,
      message: `source classification failed: ${(e as Error).message}`,
    });
  }

  return result;
}
