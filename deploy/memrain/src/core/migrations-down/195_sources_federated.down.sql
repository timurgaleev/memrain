-- 195_sources_federated.down.sql — undo migration 195.
--
--   bun run src/cli.ts apply-migrations --down 195 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 195_sources_federated.down.sql
--
-- Drops sources.federated and 195's migrations row: unscoped reads span every
-- source again once code from before 195 runs. Federation choices made since
-- are lost. It refuses, and changes nothing, unless 195 is the latest
-- migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 195 THEN
    RAISE EXCEPTION '195 down: migration 195 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE sources DROP COLUMN IF EXISTS federated;

DELETE FROM migrations WHERE id = 195;
