/**
 * Embed-skip — a frontmatter marker (no DB column) that excludes a document
 * from EMBEDDING while leaving it fully searchable via the keyword arm.
 * Sibling to the `quarantine`/`content_flag` markers in `quarantine.ts`:
 *
 *   * `quarantine`   — HIDE from search (visibility filter).
 *   * `content_flag` — WARN but stay searchable (marker only).
 *   * `embed_skip`   — INDEX + keyword-search normally, but never embed.
 *
 * A page carries the marker when its body is unsuitable for the vector arm
 * (e.g. oversized — the deferred content-sanity writer stamps it) or when the
 * operator hand-declares `embed_skip` in the markdown frontmatter. Either way
 * the predicate is key-existence: marker CONTENTS are diagnostic, not
 * functional, so a future marker-shape change never breaks the filter.
 *
 * Two surfaces:
 *   - `isEmbedSkipped(frontmatter)` for callers holding an in-memory page
 *     object (the inline indexer embed path).
 *   - `embedSkipFilterFragment(docAlias)` for callers splicing into ranking /
 *     backfill SQL (the missing-chunk embed path). The fragment targets the
 *     `documents` row — memrain embeds CHUNKS joined to their document, and the
 *     markdown frontmatter lands on `documents.frontmatter` at index time.
 *
 * The embed-coverage METRIC (source-health, and everything downstream of it:
 * doctor, advisor, remediation's per-source probe) applies the same filter to
 * its embeddable-chunk denominator, so paths and metric agree — an embed-skip
 * page's chunks neither embed nor count against coverage, and the metric can
 * reach 100%.
 *
 * Scope: this is a CHUNK marker. The page's `## Facts`
 * fence still embeds into `entity_facts.embedding` (a separate derived vector
 * arm, stripped before chunking) — `embed_skip` is "don't embed this page's
 * chunks", not "no vector arm at all".
 *
 * Writer contract: the marker takes effect at INDEX time (the indexer skips the
 * embed, the indexer-tx cascade wipes any prior chunk vectors). A future writer
 * that stamps `embed_skip` MUST reindex the page (or delete its embedding rows)
 * — a bare `UPDATE documents SET frontmatter` would leave stale vectors that the
 * backfill filter then refuses to touch, so they would keep surfacing.
 */
import { assertSqlAlias } from "./quarantine.ts";

/** The frontmatter key name. Stable contract — renaming it means rewriting
 *  every consumer of the skip semantic. */
export const EMBED_SKIP_KEY = "embed_skip";

/** True when a frontmatter object carries the embed-skip marker. Accepts a
 *  null/undefined frontmatter (some paths build page objects without one) and
 *  returns false. Mirrors the SQL fragment's key-existence semantics. */
export function isEmbedSkipped(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return !!frontmatter && Object.hasOwn(frontmatter, EMBED_SKIP_KEY);
}

/**
 * SQL fragment (a boolean expression, NO leading `AND`) that is true for
 * documents WITHOUT the embed-skip marker — i.e. the ones that SHOULD be
 * embedded. `docAlias` is the `documents` row alias in scope. COALESCE guards a
 * NULL frontmatter (treated as not-skipped). The JSONB `?` key-existence
 * operator is unambiguous under memrain's `$N` placeholders (no `?` clash).
 */
export function embedSkipFilterFragment(docAlias = "d"): string {
  assertSqlAlias(docAlias);
  return `NOT (COALESCE(${docAlias}.frontmatter, '{}'::jsonb) ? '${EMBED_SKIP_KEY}')`;
}

/**
 * The embeddable-chunk predicate (a boolean SQL expression, NO leading `AND`):
 * a chunk of a live document that is not code, not embed-skipped, and has
 * content to embed. The embed backfill picks its candidates with it and the
 * coverage metric (source-health, and doctor / remediation behind it) counts
 * its denominator with it: a chunk one side counts and the other never embeds
 * pins coverage below 100% and fails every re-embed that "embedded nothing".
 * Code chunks are embedded by the code indexer and `memrain embed --code`
 * (`codeEmbeddableChunkFragment`), never by the automatic prose fills.
 */
export function embeddableChunkFragment(docAlias = "d", chunkAlias = "c"): string {
  assertSqlAlias(docAlias);
  assertSqlAlias(chunkAlias);
  return `${docAlias}.deleted_at IS NULL AND NOT ${docAlias}.archived
        AND COALESCE(${docAlias}.frontmatter->>'kind','') <> 'code'
        AND ${embedSkipFilterFragment(docAlias)}
        AND length(btrim(${chunkAlias}.content)) > 0`;
}

/** The code half: a non-empty chunk of a live, unarchived code document. */
export function codeEmbeddableChunkFragment(docAlias = "d", chunkAlias = "c"): string {
  assertSqlAlias(docAlias);
  assertSqlAlias(chunkAlias);
  return `${docAlias}.deleted_at IS NULL AND NOT ${docAlias}.archived
        AND ${docAlias}.frontmatter->>'kind' = 'code'
        AND length(btrim(${chunkAlias}.content)) > 0`;
}
