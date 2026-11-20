-- 176_hot_memory_source_slug_index.sql — index hot_memory.source_slug and
-- hot_memory.superseded_by.
--
-- Purging a page removes its hot_memory rows, and re-points observations
-- they replaced, by `source_slug = ANY(...)` (pages-purge.ts); a page rename
-- moves them by `source_slug = $1` (pages.ts). Deleting a row also makes the
-- superseded_by foreign key (ON DELETE SET NULL) look up every row that points
-- at it. With neither column indexed, every purge and rename scanned the whole
-- table, once more per deleted row. Partial: a row with no source page, or not
-- replaced, is never looked up by that column.
--
-- Plain CREATE INDEX, no CONCURRENTLY: migrations apply in one transaction per
-- file, and the runner's lock_timeout bounds the wait on a busy table.

CREATE INDEX IF NOT EXISTS hot_memory_source_slug_idx
  ON hot_memory (source_slug)
  WHERE source_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS hot_memory_superseded_by_idx
  ON hot_memory (superseded_by)
  WHERE superseded_by IS NOT NULL;
