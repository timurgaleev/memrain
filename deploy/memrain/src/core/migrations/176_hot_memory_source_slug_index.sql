-- 176_hot_memory_source_slug_index.sql — index hot_memory.source_slug.
--
-- Purging a page removes its hot_memory rows, and re-points observations
-- they replaced, by `source_slug = ANY(...)` (pages-purge.ts); a page rename
-- moves them by `source_slug = $1` (pages.ts). With no index on source_slug
-- every purge and rename scanned the whole table. Partial: a row with no
-- source page is never looked up by it.
--
-- Plain CREATE INDEX, no CONCURRENTLY: migrations apply in one transaction per
-- file, and the runner's lock_timeout bounds the wait on a busy table.

CREATE INDEX IF NOT EXISTS hot_memory_source_slug_idx
  ON hot_memory (source_slug)
  WHERE source_slug IS NOT NULL;
