/**
 * Read a page's (or document's) content chunks in order.
 *
 * The brain stores searchable text as `chunks` rows hanging off a parent
 * `documents` row. A *page* gets its search chunks through the page→search
 * mirror: the mirror document has `source_path = 'page://' || slug` (see
 * page-index.ts). So "give me this page's chunks" resolves to "give me the
 * chunks of the mirror document for that slug".
 *
 * Chunks come back ordered by `chunk_index` so the caller can stitch the
 * original text back together. READ-only — no Bedrock, no writes.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { pageSourcePath } from "./page-index.ts";
import { quarantineFilterFragment } from "./quarantine.ts";

export interface ChunkRow {
  chunkId: string;
  chunkIndex: number;
  content: string;
  /** Code-chunk symbol identity (NULL for prose chunks). */
  symbolName: string | null;
}

export interface ChunkReadOptions {
  /** Also return the chunks of a quarantined document. Operator reads only. */
  includeQuarantined?: boolean;
}

/**
 * Return every chunk belonging to the document at `sourcePath`, ordered by
 * `chunk_index`. An unknown / chunk-less source yields an empty array — the
 * absence of a document is not an error here (the caller decides what that
 * means). A quarantined document reads as chunk-less unless the caller opts in.
 */
export async function getChunksForSource(
  storage: Storage,
  sourcePath: string,
  sourceIds?: string[],
  opts: ChunkReadOptions = {},
): Promise<ChunkRow[]> {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("getChunksForSource: `sourcePath` is required");
  }

  const db = storage.engine();
  const params: unknown[] = [sourcePath];
  // Tenant scope: a chunk's owning source is its parent document's source_id.
  // Undefined => unscoped (back-compat); `[]` => nothing.
  const scopeFilter = andSourceScope("d.source_id", sourceIds, params);
  const quarantineFilter = opts.includeQuarantined === true ? "" : ` AND ${quarantineFilterFragment("d")}`;
  const result = await db.query<{
    id: string;
    chunk_index: number;
    content: string;
    symbol_name: string | null;
  }>(
    `SELECT c.id, c.chunk_index, c.content, c.symbol_name
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = $1${scopeFilter}${quarantineFilter}
      ORDER BY c.chunk_index`,
    params,
  );

  return result.rows.map((r) => ({
    chunkId: r.id,
    chunkIndex: r.chunk_index,
    content: r.content,
    symbolName: r.symbol_name,
  }));
}

/**
 * Return a page's content chunks in order, by resolving the slug to its
 * `page://<slug>` mirror document. Thin wrapper over
 * {@link getChunksForSource}.
 */
export async function getChunksForPage(
  storage: Storage,
  slug: string,
  sourceIds?: string[],
  opts: ChunkReadOptions = {},
): Promise<ChunkRow[]> {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("getChunksForPage: `slug` is required");
  }
  // The mirror id is tenant-aware (see pageSourcePath): a non-'default' owner
  // gets `page://<sourceId>/<slug>`, so a bare `page://<slug>` lookup misses it.
  //   - single-source scoped read → that tenant IS the owner (no extra query).
  //   - otherwise (unscoped whole-brain OR multi-source scope) → resolve the
  //     page's real owner from the `pages` store so a whole-brain caller (the
  //     static bearer / operator) can read a tenant page's chunks by slug.
  // The `d.source_id` scope filter in getChunksForSource still gates the read,
  // so resolving the owner unscoped here never leaks across a caller's grant.
  const owner =
    sourceIds?.length === 1
      ? sourceIds[0]
      : await resolvePageOwner(storage, slug);
  return getChunksForSource(storage, pageSourcePath(slug, owner), sourceIds, opts);
}

/**
 * The owning source of a live page, or `undefined` when the slug has no page
 * row (e.g. a legacy mirror document with no `pages` entry — keeps the bare
 * `page://<slug>` back-compat path). Read-only, keyed on the slug PK.
 */
async function resolvePageOwner(
  storage: Storage,
  slug: string,
): Promise<string | undefined> {
  const r = await storage.engine().query<{ source_id: string }>(
    `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
    [slug],
  );
  return r.rows[0]?.source_id;
}
