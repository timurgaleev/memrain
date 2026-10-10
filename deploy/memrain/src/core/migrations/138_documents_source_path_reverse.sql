-- 138_documents_source_path_reverse.sql — index documents.source_path reversed.
--
-- A page's `path:line` citation of a code file resolves by suffix
-- (links.ts CODE_REF_LOOKUP_SQL). As `source_path LIKE '%/<path>'` the btree on
-- source_path (001) could not serve the leading wildcard, so every citation of
-- every page write scanned all documents. The lookup now matches the reversed
-- path by prefix, which a text_pattern_ops btree on reverse(source_path)
-- serves under any collation. A pg_trgm GIN index was measured and not chosen:
-- the `.ts` and `/src/` trigrams every code path shares kept the planner on a
-- sequential scan.
--
-- Plain CREATE INDEX, no CONCURRENTLY: migrations apply in one transaction per
-- file, and the runner's lock_timeout bounds the wait on a busy table.

CREATE INDEX IF NOT EXISTS documents_source_path_rev_idx
  ON documents (reverse(source_path) text_pattern_ops);
