-- 128_jobs_deferred_count.down.sql — undo migration 128.
--
--   bun run src/cli.ts apply-migrations --down 128 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 128_jobs_deferred_count.down.sql
--
-- Drops the defer counter and 128's migrations row. Rows waiting out an outage
-- stay pending and an older release claims them as usual; it never read the
-- column. It refuses, and changes nothing, unless 128 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 128 THEN
    RAISE EXCEPTION '128 down: migration 128 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE jobs DROP COLUMN IF EXISTS deferred_count;

DELETE FROM migrations WHERE id = 128;
