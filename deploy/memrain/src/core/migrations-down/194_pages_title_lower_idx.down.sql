-- 194_pages_title_lower_idx.down.sql — undo migration 194.
--
--   bun run src/cli.ts apply-migrations --down 194 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 194_pages_title_lower_idx.down.sql
--
-- Drops the lower(title) index and 194's migrations row. No data is touched;
-- the alias fan-out's title lookup goes back to scanning the pages table.
-- It refuses, and changes nothing, unless 194 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 194 THEN
    RAISE EXCEPTION '194 down: migration 194 is not the latest applied migration';
  END IF;
END
$down$;

DROP INDEX IF EXISTS pages_title_lower_idx;

DELETE FROM migrations WHERE id = 194;
