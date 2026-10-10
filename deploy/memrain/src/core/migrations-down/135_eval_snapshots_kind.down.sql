-- 135_eval_snapshots_kind.down.sql — undo migration 135.
--
--   bun run src/cli.ts apply-migrations --down 135 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 135_eval_snapshots_kind.down.sql
--
-- Drops the kind column and 135's migrations row. A/B and gate rows go with
-- it: an older release reads the newest row as the probe's latest, and would
-- take an A/B result for one. It refuses, and changes nothing, unless 135 is
-- the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 135 THEN
    RAISE EXCEPTION '135 down: migration 135 is not the latest applied migration';
  END IF;
END
$down$;

DELETE FROM eval_snapshots WHERE kind <> 'probe';
ALTER TABLE eval_snapshots DROP CONSTRAINT IF EXISTS eval_snapshots_kind_check;
ALTER TABLE eval_snapshots DROP COLUMN kind;

DELETE FROM migrations WHERE id = 135;
