-- 192_code_prunes.down.sql — undo migration 192.
--
--   bun run src/cli.ts apply-migrations --down 192 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 192_code_prunes.down.sql
--
-- Drops the prune provenance. Documents a code sweep retired stay soft-deleted
-- and are purged on the usual schedule; without this table they can only be
-- restored one by one through the generic document restore. It refuses, and
-- changes nothing, unless 192 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 192 THEN
    RAISE EXCEPTION '192 down: migration 192 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS code_prunes;

DELETE FROM migrations WHERE id = 192;
