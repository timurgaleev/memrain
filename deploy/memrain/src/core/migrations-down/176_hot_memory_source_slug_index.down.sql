-- 176_hot_memory_source_slug_index.down.sql — undo migration 176.
--
--   bun run src/cli.ts apply-migrations --down 176 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 176_hot_memory_source_slug_index.down.sql
--
-- Drops the source_slug and superseded_by indexes and 176's migrations row.
-- No data is touched; a page purge or rename goes back to scanning hot_memory.
-- It refuses, and changes nothing, unless 176 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 176 THEN
    RAISE EXCEPTION '176 down: migration 176 is not the latest applied migration';
  END IF;
END
$down$;

DROP INDEX IF EXISTS hot_memory_superseded_by_idx;
DROP INDEX IF EXISTS hot_memory_source_slug_idx;

DELETE FROM migrations WHERE id = 176;
