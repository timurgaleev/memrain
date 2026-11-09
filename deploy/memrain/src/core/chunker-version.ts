/**
 * chunker-version.ts — re-chunk staleness over `documents.chunker_version`
 * (migration 052).
 *
 * A document is STALE for re-chunking when its stamped chunker version is below
 * the CURRENT version of the chunker that produced it. The two chunkers carry
 * independent version namespaces (markdown vs code), so the staleness check
 * branches on document kind. memrain treats markdown as the NEGATION of code
 * (`frontmatter->>'kind' <> 'code'`) because markdown frontmatter is user-shaped
 * and usually carries no `kind`. This holds for memrain's two-kind (markdown +
 * code) corpus — if a third doc kind is ever indexed it would fall into the
 * markdown comparison; split the predicate then.
 *
 * Detection compares against the current versions. Automatic maintenance uses
 * its separately approved Markdown floor; a new version alone does not opt an
 * unchanged corpus into paid work. `reindex --rechunk-stale` previews the exact
 * current-version targets before a bounded, hash-pinned apply.
 */
import type { Engine } from "./engine/interface.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { CODE_CHUNKER_VERSION } from "./chunkers/code.ts";

// The kind-branched staleness predicate, shared by the count + the id list so
// the two never drift. $1 = CODE_CHUNKER_VERSION, $2 = MARKDOWN_CHUNKER_VERSION.
const STALE_CHUNKER_WHERE = `d.deleted_at IS NULL
        AND (
          (COALESCE(d.frontmatter->>'kind','') = 'code'  AND d.chunker_version < $1)
          OR
          (COALESCE(d.frontmatter->>'kind','') <> 'code' AND d.chunker_version < $2)
        )`;

/**
 * Count live documents whose chunks predate the current chunker version for
 * their kind. Single engine.query (no postgres/PGLite branch). Soft-deleted
 * documents are excluded.
 */
export async function countStaleChunkerDocs(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents d WHERE ${STALE_CHUNKER_WHERE}`,
    [CODE_CHUNKER_VERSION, MARKDOWN_CHUNKER_VERSION],
  );
  return r.rows[0]?.n ?? 0;
}

/** Narrow the stale set to one chunker namespace — the same kind branch as
 *  STALE_CHUNKER_WHERE, applied on top of it. */
const KIND_WHERE = {
  code: `COALESCE(d.frontmatter->>'kind','') = 'code'`,
  markdown: `COALESCE(d.frontmatter->>'kind','') <> 'code'`,
} as const;

/**
 * The document ids of live chunker-stale documents. Used by `reindex
 * --rechunk-stale` to force-reindex ONLY these (re-chunk + re-embed just the
 * stale set, not the whole corpus). The id matches `docId(source_path)`, so the
 * vault sweep can test membership per walked file. memrain can't re-chunk from the
 * DB (documents store no full body — only `chunks.content`), so remediation
 * re-reads the source file; this targets the subset worth re-reading.
 *
 * `kind` is REQUIRED: every caller is a sweep that walks exactly one corpus, and
 * an unnarrowed set hands it stale docs of the other kind — which that walk can
 * never reach — to report as unreached orphans. The cross-kind total belongs to
 * countStaleChunkerDocs, which is the doctor's metric, not a work list.
 */
export async function listStaleChunkerDocIds(
  engine: Engine,
  kind: keyof typeof KIND_WHERE,
): Promise<Set<string>> {
  const r = await engine.query<{ id: string }>(
    `SELECT d.id FROM documents d WHERE ${STALE_CHUNKER_WHERE} AND ${KIND_WHERE[kind]}`,
    [CODE_CHUNKER_VERSION, MARKDOWN_CHUNKER_VERSION],
  );
  return new Set(r.rows.map((row) => row.id));
}
