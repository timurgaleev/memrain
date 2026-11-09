/**
 * rechunk-sweep — the automatic, cost-gated re-chunk + re-embed sweep that
 * drains chunker-version-stale documents a bounded batch at a time.
 *
 * memrain already TRACKS chunker staleness (`documents.chunker_version` vs
 * MARKDOWN_CHUNKER_VERSION — see chunker-version.ts) and exposes a MANUAL
 * `reindex --rechunk-stale` that walks the whole vault. What it lacked is the
 * AUTOMATIC drain below the approved upgrade floor. A new markdown chunker
 * version alone must not start a corpus re-chunk + re-embed: that is a surprise
 * Bedrock bill and a long wall-clock stall. This phase spreads the work across
 * ticks under a hard per-tick cap.
 *
 * DELIBERATELY OPT-IN + BOUNDED (it spends Bedrock Titan on every re-embed):
 *   - default-OFF behind `MEMRAIN_RECHUNK_SWEEP=1` (an injected `embedFn` bypasses
 *     the gate for hermetic tests, same seam as the other paid phases);
 *   - COUNT-capped per tick (`maxDocs`, env MEMRAIN_RECHUNK_SWEEP_MAX, default 25);
 *   - CHAR-BUDGET-capped per tick (`maxChars`, env MEMRAIN_RECHUNK_SWEEP_MAX_CHARS,
 *     default 1,000,000) as a spend proxy — always drains at least one doc, then
 *     stops before crossing the budget so a huge doc can never starve the tick.
 *
 * RESUMABLE across ticks WITHOUT any cursor: re-indexing a doc re-stamps its
 * `chunker_version` to the current markdown version (see indexer.ts), so it
 * leaves the stale set and the next tick's bounded query naturally advances to
 * the next batch. IDEMPOTENT: a doc already at the current version never matches
 * the staleness predicate, so a fresh doc is never re-done.
 *
 * MARKDOWN-ONLY. `indexDocument` is the
 * markdown ingest path (it stamps MARKDOWN_CHUNKER_VERSION and markdown-chunks
 * the body); running a `kind='code'` doc through it would mis-stamp and
 * mis-chunk it. Code docs re-chunk lazily on their own reindex. The predicate is
 * the markdown branch of chunker-version.ts's STALE_CHUNKER_WHERE.
 *
 * TENANCY: each row's own `source_id` is read back and passed to the re-index so
 * the sweep preserves the owning tenant rather than resetting it to default.
 * A remote inline `index` labels its row with any path, so a row is re-read
 * only through `readGuardedFile`, as embed-stale does.
 */
import { existsSync } from "node:fs";
import type { Engine } from "../engine/interface.ts";
import type { EmbedFn } from "../indexer.ts";
import { Storage } from "../storage.ts";
import { indexDocument } from "../indexer.ts";
import { AUTO_MARKDOWN_RECHUNK_VERSION } from "../chunkers/recursive.ts";
import { loadAllowedRootSpellings } from "../path_guard.ts";
import { loadRereadGuard, readGuardedFile, REREAD_SCAN_FACTOR, rereadCandidateWhere } from "../sources.ts";
import { OperationError } from "../operation-error.ts";
import { logOwnerConflicts } from "./embed-stale.ts";
import { phaseCheckpoint, phaseFenceCheck } from "./phase-context.ts";

const DEFAULT_MAX_DOCS = 25;
const DEFAULT_MAX_CHARS = 1_000_000;

export interface RechunkSweepOptions {
  /** Hard cap on docs re-chunked per tick. Default MEMRAIN_RECHUNK_SWEEP_MAX or 25. */
  maxDocs?: number;
  /**
   * Cumulative source-char budget per tick (spend proxy). Default
   * MEMRAIN_RECHUNK_SWEEP_MAX_CHARS or 1,000,000. At least one doc always runs.
   */
  maxChars?: number;
  /**
   * Embedder seam. Injected in tests to stay offline; when set it ALSO bypasses
   * the MEMRAIN_RECHUNK_SWEEP env gate (same pattern as the paid synthesis phases'
   * injected LLM fns). Production leaves it unset → real Titan + the env gate.
   */
  embedFn?: EmbedFn;
  /** Embedding model id override (tests). */
  embeddingModel?: string;
}

export interface RechunkSweepResult {
  /** False when the phase was gated off (disabled + no injected embedder). */
  ran: boolean;
  reason?: string;
  /** Candidate stale docs fetched this tick (bounded by maxDocs × REREAD_SCAN_FACTOR). */
  scanned: number;
  /** Docs actually re-chunked + re-embedded this tick. */
  rechunked: number;
  /** Stale docs whose source file was gone from disk (skipped; orphans-purge collects). */
  skippedMissing: number;
  /** Candidates the re-read guard refused (denied name, wrong owner, outside the roots). */
  rejected: number;
  /** Cumulative source chars re-embedded this tick. */
  charsProcessed: number;
  /** True when the char budget stopped the tick before the count cap. */
  budgetExhausted: boolean;
  errors: { sourcePath: string; message: string }[];
}

interface StaleRow {
  id: string;
  source_path: string;
  source_id: string | null;
  last_indexed_mtime: number | null;
}

/**
 * The markdown-only, chunker-version-stale doc set a local re-read may refresh,
 * bounded to `limit` and ordered deterministically so the tick-to-tick drain is
 * stable. `after` is the last `source_path` of the previous page.
 */
export async function findChunkerStaleDocs(
  engine: Engine,
  limit: number,
  roots: readonly string[],
  after: string | null = null,
): Promise<StaleRow[]> {
  if (roots.length === 0) return [];
  const r = await engine.query<StaleRow>(
    `SELECT d.id, d.source_path, d.source_id, d.last_indexed_mtime
       FROM documents d
      WHERE d.deleted_at IS NULL
        AND COALESCE(d.frontmatter->>'kind','') <> 'code'
        AND d.chunker_version < $1
        AND ${rereadCandidateWhere(3)}
        AND ($4::text IS NULL OR d.source_path > $4::text)
      ORDER BY d.source_path
      LIMIT $2`,
    [AUTO_MARKDOWN_RECHUNK_VERSION, limit, roots as string[], after],
  );
  return r.rows;
}

function resolveCap(opt: number | undefined, envName: string, fallback: number): number {
  if (typeof opt === "number" && opt > 0) return opt;
  const raw = (process.env[envName] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function rechunkSweepPhase(
  engine: Engine,
  opts: RechunkSweepOptions = {},
): Promise<RechunkSweepResult> {
  const base: RechunkSweepResult = {
    ran: false,
    scanned: 0,
    rechunked: 0,
    skippedMissing: 0,
    rejected: 0,
    charsProcessed: 0,
    budgetExhausted: false,
    errors: [],
  };

  // Gate: OFF unless MEMRAIN_RECHUNK_SWEEP=1 — but an injected embedder (tests)
  // bypasses the gate so the drain can be exercised without live Bedrock.
  if (!opts.embedFn && process.env.MEMRAIN_RECHUNK_SWEEP !== "1") {
    return { ...base, reason: "disabled (MEMRAIN_RECHUNK_SWEEP not set)" };
  }

  const maxDocs = resolveCap(opts.maxDocs, "MEMRAIN_RECHUNK_SWEEP_MAX", DEFAULT_MAX_DOCS);
  const maxChars = resolveCap(opts.maxChars, "MEMRAIN_RECHUNK_SWEEP_MAX_CHARS", DEFAULT_MAX_CHARS);

  const roots = loadAllowedRootSpellings();
  const mayReread = await loadRereadGuard(engine, roots);
  const result: RechunkSweepResult = { ...base, ran: true };

  const storage = new Storage(engine);
  const indexOpts: { embedFn?: EmbedFn; embeddingModel?: string } = {};
  if (opts.embedFn) indexOpts.embedFn = opts.embedFn;
  if (opts.embeddingModel) indexOpts.embeddingModel = opts.embeddingModel;

  // maxDocs counts re-chunks attempted; rows skipped before any read only spend
  // the scan budget, so a row refused every tick cannot hold the cap.
  const scanBudget = maxDocs * REREAD_SCAN_FACTOR;
  let attempted = 0;
  const conflicts: string[] = [];
  let after: string | null = null;
  while (!result.budgetExhausted && attempted < maxDocs && result.scanned < scanBudget) {
    const limit = Math.min(maxDocs - attempted, scanBudget - result.scanned);
    const page = await findChunkerStaleDocs(engine, limit, roots, after);
    if (page.length === 0) break;
    result.scanned += page.length;
    after = page[page.length - 1]!.source_path;
    for (const row of page) {
      phaseCheckpoint();
      if (!existsSync(row.source_path)) {
        result.skippedMissing++;
        continue; // orphans-purge handles a doc whose file is gone
      }
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
        await indexDocument(
          storage,
          {
            sourcePath: row.source_path,
            text: file.text,
            sourceId: row.source_id,
            mtimeMs: file.mtimeMs,
            expectOwner: row.source_id,
          },
          indexOpts,
        );
        result.rechunked++;
        result.charsProcessed += file.text.length;
        // Spend proxy: once this tick has crossed the char budget, stop and let
        // the next tick pick up the rest (the drain is resumable by construction).
        if (result.charsProcessed >= maxChars) {
          result.budgetExhausted = true;
          break;
        }
      } catch (e) {
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
  logOwnerConflicts("rechunk-sweep", conflicts);
  return result;
}
