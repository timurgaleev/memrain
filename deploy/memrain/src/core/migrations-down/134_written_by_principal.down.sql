-- 134_written_by_principal.down.sql — undo migration 134.
--
--   bun run src/cli.ts apply-migrations --down 134 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 134_written_by_principal.down.sql
--
-- Drops written_by_principal from page_versions, entity_facts and
-- timeline_events, and 134's migrations row. The rows themselves stay; only
-- the recorded principal is lost, which an older release never had.
-- It refuses, and changes nothing, unless 134 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 134 THEN
    RAISE EXCEPTION '134 down: migration 134 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE page_versions DROP COLUMN IF EXISTS written_by_principal;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS written_by_principal;
ALTER TABLE timeline_events DROP COLUMN IF EXISTS written_by_principal;

DELETE FROM migrations WHERE id = 134;
