-- 121_eval_snapshots_status.down.sql — undo migration 121.
--
--   bun run src/cli.ts apply-migrations --down 121 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 121_eval_snapshots_status.down.sql
--
-- Drops the status column and 121's migrations row. Rows the probe recorded as
-- 'error' carry zeroed scalars that an older release would read as a real
-- (empty) measurement, so they are deleted with the column. It refuses, and
-- changes nothing, unless 121 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 121 THEN
    RAISE EXCEPTION '121 down: migration 121 is not the latest applied migration';
  END IF;
END
$down$;

DELETE FROM eval_snapshots WHERE status = 'error';
ALTER TABLE eval_snapshots DROP CONSTRAINT IF EXISTS eval_snapshots_status_check;
ALTER TABLE eval_snapshots DROP COLUMN status;

DELETE FROM migrations WHERE id = 121;
