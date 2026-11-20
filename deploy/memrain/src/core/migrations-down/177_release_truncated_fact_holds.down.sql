-- 177_release_truncated_fact_holds.down.sql — undo migration 177.
--
--   bun run src/cli.ts apply-migrations --down 177 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 177_release_truncated_fact_holds.down.sql
--
-- Removes 177's migrations row only. The waits it ended are not restored: a
-- page that still truncates is parked again by its next failure.
-- It refuses, and changes nothing, unless 177 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 177 THEN
    RAISE EXCEPTION '177 down: migration 177 is not the latest applied migration';
  END IF;
END
$down$;

DELETE FROM migrations WHERE id = 177;
