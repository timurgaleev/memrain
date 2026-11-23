/**
 * chunker-version.ts — re-chunk staleness over `documents.chunker_version`
 * (migration 052).
 *
 * A markdown document is STALE for re-chunking when its stamped chunker
 * version is below the current markdown chunker's. Markdown is the NEGATION of
 * code (`frontmatter->>'kind' <> 'code'`) because markdown frontmatter is
 * user-shaped and usually carries no `kind`. Code documents an earlier build
 * indexed are never stale here: nothing in this build re-chunks code.
 *
 * Detection compares against the current versions. Automatic maintenance uses
 * its separately approved Markdown floor; a new version alone does not opt an
 * unchanged corpus into paid work. `reindex --rechunk-stale` previews the exact
 * current-version targets before a bounded, hash-pinned apply.
 */
import type { Engine } from "./engine/interface.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";

// The staleness predicate, shared by the count + the id list so the two never
// drift. $1 = MARKDOWN_CHUNKER_VERSION.
const STALE_CHUNKER_WHERE = `d.deleted_at IS NULL
        AND COALESCE(d.frontmatter->>'kind','') <> 'code' AND d.chunker_version < $1`;

/**
 * Count live documents whose chunks predate the current chunker version for
 * their kind. Single engine.query (no postgres/PGLite branch). Soft-deleted
 * documents are excluded.
 */
export async function countStaleChunkerDocs(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents d WHERE ${STALE_CHUNKER_WHERE}`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * The document ids of live chunker-stale markdown documents. Used by `reindex
 * --rechunk-stale` to force-reindex ONLY these (re-chunk + re-embed just the
 * stale set, not the whole corpus). The id matches `docId(source_path)`, so the
 * vault sweep can test membership per walked file. The DB stores no full body
 * (only `chunks.content`), so remediation re-reads the source file; this
 * targets the subset worth re-reading.
 */
export async function listStaleChunkerDocIds(engine: Engine): Promise<Set<string>> {
  const r = await engine.query<{ id: string }>(
    `SELECT d.id FROM documents d WHERE ${STALE_CHUNKER_WHERE}`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  return new Set(r.rows.map((row) => row.id));
}
