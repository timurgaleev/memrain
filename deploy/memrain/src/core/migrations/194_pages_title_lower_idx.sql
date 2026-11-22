-- 194_pages_title_lower_idx.sql — index page titles for exact name lookups.
--
-- The alias fan-out resolves an entity a query names by its title on every
-- search (`lower(title) = ANY(...)`), which without an index scanned the whole
-- pages table each time.
--
-- Plain CREATE INDEX, no CONCURRENTLY: migrations apply in one transaction per
-- file, and the runner's lock_timeout bounds the wait on a busy table.

CREATE INDEX IF NOT EXISTS pages_title_lower_idx
  ON pages (lower(title));
