/**
 * Code sweep — walks one or more registered code-source roots, mtime-skips
 * unchanged files, calls indexCodeFile() for the rest. Mirrors the shape
 * of `core/sweep.ts sweepVault` so operators reason about both flows the
 * same way.
 *
 * Supported extensions come from `chunkers/parsers.SUPPORTED_EXTENSIONS`
 * — adding a new language flips this set automatically.
 *
 * Failure semantics:
 *   - Parse errors in one file → log to result.errors, continue with the next.
 *   - Missing/unreadable file → silently skipped by the walker.
 *   - WASM load failure → propagates up (hard fail, fixed at boot).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Storage } from "./storage.ts";
import { indexCodeFile } from "./indexer-code.ts";
import { codeEmbedCap } from "./code-embed.ts";
import { normalizeSourcePath } from "./indexer.ts";
import { walkFiles } from "./walk.ts";
import { listStaleChunkerDocIds } from "./chunker-version.ts";
import { SUPPORTED_EXTENSIONS } from "./chunkers/parsers.ts";
import { backfillDocumentSources, loadRereadGuard, type StoredDocument } from "./sources.ts";
import { LEGACY_DATA_DIR } from "./brand.ts";
import {
  codePruneAutoEnabled,
  heldCodePruneDocIds,
  openCodePruneDocIds,
  releaseCodePruneHold,
  pruneCodeRoots,
  restoreCodePrunes,
  type CodePruneResult,
  type CodeWalkEvidence,
} from "./code-prune.ts";

export interface SweepCodeOptions {
  /** Filesystem roots to sweep (each becomes its own source). */
  paths: readonly string[];
  /** Directory basenames to skip. Defaults cover common build artifacts. */
  ignore?: readonly string[];
  /** When true, re-index every file regardless of mtime. */
  force?: boolean;
  /** Sleep this many ms between consecutive file indexes. */
  perFileDelayMs?: number;
  /** Stop after this many *re-indexes* (skipped files don't count). */
  maxFiles?: number;
  /**
   * Force-reindex documents whose stamped `chunker_version` is below
   * CODE_CHUNKER_VERSION (migration 052), even when mtime is unchanged — the
   * code half of `reindex --rechunk-stale`, same shape as `sweepVault`.
   *
   * Without it a CODE_CHUNKER_VERSION bump drains only via `--all`, because an
   * unchanged file mtime-skips no matter how old its chunks are. Targeted, not
   * free: on a bump EVERY code doc is stale, so the first run re-parses the
   * whole corpus; what it buys over `--all` is that already-current files are
   * skipped, so the run is resumable and the second run costs nothing.
   */
  forceStaleChunker?: boolean;
  /**
   * After a complete walk, soft-delete the documents of files gone from each
   * root (core/code-prune.ts, within its valve). Defaults to
   * `MEMRAIN_CODE_PRUNE` (on).
   */
  prune?: boolean;
}

export interface SweepCodeResult {
  scanned: number;
  reindexed: number;
  skipped: number;
  parseErrors: number;
  errors: { path: string; message: string }[];
  /** Per-root file counts. Useful for the empty-root WARNING in serve.ts. */
  perRoot: { root: string; files: number; missing: boolean }[];
  /**
   * `forceStaleChunker` only: ids of chunker-stale code documents the walk never
   * reached (file deleted/moved, under an ignored dir, or indexed from a path
   * outside the configured roots). They stay stale until their file reappears or
   * they are purged — surfaced so the run signals the gap instead of reporting
   * a clean drain. Same contract as `SweepResult.staleChunkerUnreached`.
   */
  staleChunkerUnreached?: string[];
  /** Chunks this walk wrote without a vector (the embedding cap or an embed failure). */
  embeddingDeferred?: number;
  /** What the prune of deleted files did, per root (absent when pruning is off). */
  prune?: CodePruneResult;
  /** Pruned documents whose file came back; the walk made them live again. */
  restored?: number;
}

// Default ignore set for the CODE sweep. Intentionally narrower than
// `sweep.ts`'s markdown ignores: a code repo can legitimately contain
// a directory named after the project (this repo's package directory
// is one). The bare name here would basename-match it and silently skip
// the entire source tree we wanted to index, so it is never listed, under
// either name. The local data dirs are dotted (`.memrain`, and `.memex`
// from before the rename); those never appear as a real source directory.
const DEFAULT_IGNORES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  ".memrain",
  LEGACY_DATA_DIR,
  "wasm",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
];

/**
 * Walk `root` the way the sweep does, without indexing: what the walk could
 * prove about the root, for `memrain code prune`.
 */
export function walkCodeRoot(root: string, ignore: readonly string[] = []): CodeWalkEvidence {
  const evidence: CodeWalkEvidence = {
    root: normalizeSourcePath(root),
    missing: !existsSync(root),
    files: 0,
    walkErrors: 0,
    partial: false,
  };
  if (evidence.missing) return evidence;
  const skip = new Set([...ignore, ...DEFAULT_IGNORES]);
  for (const _ of walkFiles(root, {
    extensions: SUPPORTED_EXTENSIONS,
    ignore: skip,
    onError: () => { evidence.walkErrors++; },
  })) {
    evidence.files++;
  }
  return evidence;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

// Sweeps running in THIS process. The boot sweep runs inside the server that
// answers MCP calls, so a process-local count is enough for the code tools to
// tell "still indexing" from "not there"; an out-of-process `memrain reindex` is
// not visible here. The roots are kept too, so a tenant whose sources the
// sweep never touches is not told its index is still building.
let sweepsInFlight = 0;
const rootsInFlight = new Map<string, number>();

/** True while a code sweep started by this process has not finished. */
export function codeSweepInProgress(): boolean {
  return sweepsInFlight > 0;
}

function trimSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

/** One path sits at or under the other, on a `/` boundary. */
function pathsOverlap(a: string, b: string): boolean {
  const x = trimSlash(a);
  const y = trimSlash(b);
  if (x === "" || y === "") return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** True while an in-flight sweep walks a root overlapping any of `prefixes`. */
export function codeSweepCovers(prefixes: readonly string[]): boolean {
  for (const root of rootsInFlight.keys()) {
    if (prefixes.some((p) => pathsOverlap(root, p))) return true;
  }
  return false;
}

/**
 * Walk every code path, mtime-skip, reindex stale.
 */
export async function sweepCodeRoots(
  storage: Storage,
  opts: SweepCodeOptions,
): Promise<SweepCodeResult> {
  const roots = opts.paths.map((p) => normalizeSourcePath(p));
  sweepsInFlight++;
  for (const r of roots) rootsInFlight.set(r, (rootsInFlight.get(r) ?? 0) + 1);
  try {
    return await sweepCodeRootsInner(storage, opts);
  } finally {
    sweepsInFlight--;
    for (const r of roots) {
      const n = (rootsInFlight.get(r) ?? 1) - 1;
      if (n > 0) rootsInFlight.set(r, n);
      else rootsInFlight.delete(r);
    }
  }
}

async function sweepCodeRootsInner(
  storage: Storage,
  opts: SweepCodeOptions,
): Promise<SweepCodeResult> {
  const ignore = new Set([...(opts.ignore ?? []), ...DEFAULT_IGNORES]);
  const result: SweepCodeResult = {
    scanned: 0,
    reindexed: 0,
    skipped: 0,
    parseErrors: 0,
    errors: [],
    perRoot: [],
  };

  // Pull all known last_indexed_mtime in one shot — cheaper than per-file SELECT.
  const known = new Map<string, StoredDocument>();
  const rows = await storage
    .raw()
    .query<{ id: string; source_id: string | null; last_indexed_mtime: number | null }>(
      "SELECT id, source_id, last_indexed_mtime FROM documents",
    );
  for (const r of rows.rows) {
    known.set(r.id, { sourceId: r.source_id, lastIndexedMtime: r.last_indexed_mtime });
  }
  const mayReread = await loadRereadGuard(storage.raw(), opts.paths);

  // Targeted re-chunk: the code-doc ids whose chunks predate the current code
  // chunker version. A walked file in this set is re-indexed regardless of
  // mtime. Kind-narrowed — this walk never sees a markdown file.
  const staleChunkerIds = opts.forceStaleChunker
    ? await listStaleChunkerDocIds(storage.raw(), "code")
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
  // One embedding cap for the whole walk: a first sweep, or a forced one, must
  // not pay per file without bound, nor add more vectors than the database
  // cache holds.
  const embedCap = await codeEmbedCap(storage.raw());
  let embeddingDeferred = 0;
  const prune = opts.prune ?? codePruneAutoEnabled();
  // Documents a prune retired whose deletion is still the prune's: when the
  // walk meets one's file again, it is re-indexed and made live (the indexer
  // never revives a deleted document by itself). Loaded even with pruning off,
  // so turning the switch off never strands a document an earlier pass retired.
  const pruned = await openCodePruneDocIds(storage.raw());
  // Documents the operator restored, held back from the automatic pass until
  // the walk sees their file again.
  const held = await heldCodePruneDocIds(storage.raw());
  const evidence: CodeWalkEvidence[] = [];

  for (const root of opts.paths) {
    const perRoot = { root, files: 0, missing: !existsSync(root) };
    const walked: CodeWalkEvidence = {
      root: normalizeSourcePath(root),
      missing: perRoot.missing,
      files: 0,
      walkErrors: 0,
      partial: false,
      arrived: [],
    };
    evidence.push(walked);
    if (perRoot.missing) {
      result.perRoot.push(perRoot);
      continue;
    }
    for (const file of walkFiles(root, {
      extensions: SUPPORTED_EXTENSIONS,
      ignore,
      onError: () => { walked.walkErrors++; },
    })) {
      walked.files++;
      perRoot.files++;
      result.scanned++;
      // Same reason as the vault sweep: indexCodeFile stores the CANONICAL
      // path, so hashing the walked shape instead makes every mtime skip miss
      // whenever a code root is relative — the whole tree re-indexes on every
      // tick and the skip quietly stops being a skip.
      const canonical = normalizeSourcePath(file.path);
      const id = docId(canonical);
      const stored = known.get(id) ?? null;
      // Same fence as the vault sweep: never read a file into a row a remote
      // `index` labelled for another source.
      const verdict = mayReread(canonical, stored);
      if (!verdict.ok) {
        console.warn(`[sweep-code] not indexing ${canonical}: ${verdict.reason}`);
        continue;
      }
      // A returned file may carry an old mtime and new content, so its pruned
      // document is re-indexed first (the write keeps it deleted) and made live
      // only once that succeeded; its old chunks never come back on their own.
      const returned = pruned.has(id);
      if (held.has(id)) {
        held.delete(id);
        try {
          await releaseCodePruneHold(storage.raw(), id);
        } catch (e) {
          result.errors.push({ path: file.path, message: `releasing a prune hold failed: ${(e as Error).message}` });
        }
      }
      const lastIndexed = stored?.lastIndexedMtime ?? null;
      const forcedByChunker = staleChunkerIds?.has(id) ?? false;
      if (forcedByChunker) seenStaleIds!.add(id);
      if (
        !opts.force &&
        !forcedByChunker &&
        !returned &&
        lastIndexed !== null &&
        lastIndexed >= file.mtimeMs
      ) {
        result.skipped++;
        indexed.push(canonical);
        continue;
      }
      if (result.reindexed >= maxFiles) {
        budgetBroke = true;
        break;
      }
      try {
        // Same re-check as the vault sweep: `known` is a snapshot.
        const out = await indexCodeFile(storage, file.path, { rereadGuard: mayReread, embedCap });
        embeddingDeferred += out.embeddingDeferred ?? 0;
        result.reindexed++;
        indexed.push(canonical);
        // A path with no document before this walk: a new file, or one end of a
        // move the prune pairs with the document its old path left behind.
        if (stored === null) walked.arrived!.push(id);
        if (out.hasParseError) result.parseErrors++;
        if (returned) {
          pruned.delete(id);
          const back = await restoreCodePrunes(storage.raw(), { documentId: id }, "file_returned");
          result.restored = (result.restored ?? 0) + back.restored.length;
        }
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
    result.perRoot.push(perRoot);
  }

  if (prune) {
    if (budgetBroke) for (const w of evidence) w.partial = true;
    try {
      result.prune = await pruneCodeRoots(storage.raw(), evidence, { trigger: "sweep", apply: true });
      logPrune(result.prune);
    } catch (e) {
      result.errors.push({ path: opts.paths.join(", "), message: `code prune failed: ${(e as Error).message}` });
    }
  }

  if (embeddingDeferred > 0) {
    result.embeddingDeferred = embeddingDeferred;
  }
  if (embeddingDeferred > 0 && !embedCap.off) {
    console.warn(
      `[code] ${embeddingDeferred} chunk(s) stored without a vector this sweep ` +
        `(${embedCap.stopReason ?? "an embed failed"}); \`memrain embed --code\` fills them`,
    );
  }

  // Only meaningful on a COMPLETE walk: a maxFiles break leaves later stale
  // files unwalked-but-not-orphaned (they resume next run), so don't flag them.
  if (staleChunkerIds && seenStaleIds && !budgetBroke) {
    const unreached = [...staleChunkerIds].filter((id) => !seenStaleIds.has(id));
    if (unreached.length > 0) result.staleChunkerUnreached = unreached;
  }

  // indexCodeFile writes no source (a trusted local caller must not be fenced
  // from rows another source owns), so the registered path prefixes classify the
  // walked files afterwards. A failure here leaves the walk's own result
  // standing — the next sweep retries the classification.
  try {
    await backfillDocumentSources(storage.raw(), indexed);
  } catch (e) {
    result.errors.push({
      path: opts.paths.join(", "),
      message: `source classification failed: ${(e as Error).message}`,
    });
  }

  return result;
}

function logPrune(r: CodePruneResult): void {
  if (r.sweep_id) {
    console.log(
      `[code] pruned ${r.pruned} document(s) of deleted files (sweep ${r.sweep_id}); ` +
        `\`memrain code restore --sweep ${r.sweep_id}\` undoes it`,
    );
  }
  for (const root of r.roots) {
    if ((root.moved ?? 0) > 0) {
      console.log(`[code] ${root.moved} document(s) under ${root.root} moved to a new path; their old paths were retired`);
    }
    if (root.reason === "mass_delete") {
      console.warn(
        `[code] prune withheld for ${root.root}: ${root.missing} of ${root.live} code document(s) have no file; ` +
          "`memrain code prune` lists them, `memrain code prune --apply --allow-mass-delete` retires them",
      );
    } else if (root.reason === "walk_errors") {
      console.warn(`[code] prune skipped for ${root.root}: the walk could not read part of it`);
    }
  }
}
