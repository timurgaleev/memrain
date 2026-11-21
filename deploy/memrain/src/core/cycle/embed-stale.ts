/**
 * embed-stale — re-embed chunks whose embedding is older than `staleDays`.
 *
 * Walks documents whose embeddings.created_at is below the threshold,
 * reads the source file from disk, calls `indexDocument()` to re-chunk +
 * re-embed via Bedrock Titan v2. File-missing rows are skipped silently;
 * `orphans-purge` will collect them.
 *
 * Originally lived in `recipes/dream.ts`. split it out so each
 * cycle phase is a single-responsibility module.
 */
import { existsSync } from "node:fs";
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { indexDocument } from "../indexer.ts";
import { loadAllowedRootSpellings } from "../path_guard.ts";
import { loadRereadGuard, readGuardedFile, REREAD_SCAN_FACTOR, rereadCandidateWhere } from "../sources.ts";
import { OperationError } from "../operation-error.ts";
import { phaseCheckpoint, phaseFenceCheck } from "./phase-context.ts";

export interface EmbedStaleOptions {
  /** Days threshold. Default 30. */
  staleDays?: number;
  /** Hard cap on re-embeds per cycle. Default 50. */
  maxPerCycle?: number;
}

export interface EmbedStaleResult {
  scanned: number;
  reembedded: number;
  /** Candidates the re-read guard refused (denied name, wrong owner, outside the roots). */
  rejected: number;
  errors: { sourcePath: string; message: string }[];
}

interface StaleRow {
  doc_id: string;
  source_path: string;
  source_id: string | null;
  last_indexed_mtime: number | null;
}

/**
 * Only documents a local sweep could have written are re-read from disk. A
 * remote `index` call labels its document with any `sourcePath` it likes —
 * `/proc/self/environ`, or a vault file not indexed yet — and re-reading that
 * label would copy the daemon's file into the caller's document.
 *
 * `rereadCandidateWhere` keeps the cap spent on rows the guard can pass;
 * `readGuardedFile` judges each by its canonical path before any read. `after`
 * is the last `source_path` of the previous page.
 */
export async function findStale(
  engine: Engine,
  staleDays: number,
  limit: number,
  roots: readonly string[],
  after: string | null = null,
): Promise<StaleRow[]> {
  if (roots.length === 0) return [];
  const r = await engine.query<StaleRow>(
    `SELECT DISTINCT d.id AS doc_id, d.source_path, d.source_id, d.last_indexed_mtime
     FROM documents d
     JOIN chunks c     ON c.document_id = d.id
     JOIN embeddings e ON e.chunk_id = c.id
     WHERE e.created_at < NOW() - ($1 || ' days')::interval
       -- A code file re-read here would go through the markdown indexer and
       -- come back as prose; its vectors age out with the file, not the clock.
       AND COALESCE(d.frontmatter->>'kind','') <> 'code'
       AND ${rereadCandidateWhere(3)}
       AND ($4::text IS NULL OR d.source_path > $4::text)
     ORDER BY d.source_path
     LIMIT $2`,
    [String(staleDays), limit, roots as string[], after],
  );
  return r.rows;
}

export async function embedStalePhase(
  engine: Engine,
  opts: EmbedStaleOptions = {},
): Promise<EmbedStaleResult> {
  const staleDays = opts.staleDays ?? 30;
  const maxPerCycle = opts.maxPerCycle ?? 50;
  const roots = loadAllowedRootSpellings();
  const mayReread = await loadRereadGuard(engine, roots);
  const result: EmbedStaleResult = {
    scanned: 0,
    reembedded: 0,
    rejected: 0,
    errors: [],
  };

  // indexDocument lives on Storage; wrap engine in one for the phase.
  const storage = new Storage(engine);
  // The cap counts re-embeds attempted; rows skipped before any read only
  // spend the scan budget, so a row refused every tick cannot hold the cap.
  const scanBudget = maxPerCycle * REREAD_SCAN_FACTOR;
  let attempted = 0;
  const conflicts: string[] = [];
  let after: string | null = null;
  while (attempted < maxPerCycle && result.scanned < scanBudget) {
    const limit = Math.min(maxPerCycle - attempted, scanBudget - result.scanned);
    const page = await findStale(engine, staleDays, limit, roots, after);
    if (page.length === 0) break;
    result.scanned += page.length;
    after = page[page.length - 1]!.source_path;
    for (const row of page) {
      phaseCheckpoint();
      if (!existsSync(row.source_path)) continue; // orphans-purge handles
      await phaseFenceCheck();
      try {
        const file = readGuardedFile(mayReread, row.source_path, {
          sourceId: row.source_id,
          lastIndexedMtime: row.last_indexed_mtime,
        });
        if (!file) {
          result.rejected++;
          continue;
        }
        attempted++;
        await indexDocument(storage, {
          sourcePath: row.source_path,
          text: file.text,
          // Keeps the local-read mark the guard relies on for an unowned row.
          mtimeMs: file.mtimeMs,
          expectOwner: row.source_id,
        });
        result.reembedded++;
      } catch (e) {
        // Another source owns the row the write lands on: nothing this phase
        // can do, so it must not spend the cap the next valid row needs.
        if (e instanceof OperationError && e.code === "permission_denied") {
          attempted--;
          result.rejected++;
          conflicts.push(row.source_path);
          continue;
        }
        result.errors.push({
          sourcePath: row.source_path,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  logOwnerConflicts("embed-stale", conflicts);
  return result;
}

/** One line per tick naming the rows an owner conflict kept from a re-read. */
export function logOwnerConflicts(phase: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const shown = paths.slice(0, 5).map((p) => JSON.stringify(p)).join(", ");
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
  console.error(`[cycle] ${phase}: ${paths.length} row(s) skipped, owned by another source: ${shown}${more}`);
}
