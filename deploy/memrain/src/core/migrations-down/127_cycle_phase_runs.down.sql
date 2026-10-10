-- 127_cycle_phase_runs.down.sql — undo migration 127.
--
--   bun run src/cli.ts apply-migrations --down 127 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 127_cycle_phase_runs.down.sql
--
-- Drops cycle_phase_runs and 127's migrations row. An older release never
-- reads the table; without it every synthesis phase runs on every quiet tick
-- again. It refuses, and changes nothing, unless 127 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 127 THEN
    RAISE EXCEPTION '127 down: migration 127 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS cycle_phase_runs;

DELETE FROM migrations WHERE id = 127;
