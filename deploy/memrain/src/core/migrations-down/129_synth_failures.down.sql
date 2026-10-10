-- 129_synth_failures.down.sql — undo migration 129.
--
--   bun run src/cli.ts apply-migrations --down 129 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 129_synth_failures.down.sql
--
-- Drops synth_failures (failed documents become eligible on the next cycle
-- again), deletes the `extracted` backfill watermarks, and narrows the
-- facts_backfill_scans outcome check back to 'zero_yield'. Pages that lose their
-- watermark fall back to the on-write fact marker. It refuses, and changes
-- nothing, unless 129 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 129 THEN
    RAISE EXCEPTION '129 down: migration 129 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE synth_failures;

DELETE FROM facts_backfill_scans WHERE outcome = 'extracted';

ALTER TABLE facts_backfill_scans
  DROP CONSTRAINT facts_backfill_scans_outcome_check;

ALTER TABLE facts_backfill_scans
  ADD CONSTRAINT facts_backfill_scans_outcome_check
  CHECK (outcome IN ('zero_yield'));

DELETE FROM migrations WHERE id = 129;
