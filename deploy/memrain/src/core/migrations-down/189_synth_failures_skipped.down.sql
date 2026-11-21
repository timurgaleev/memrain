-- 189_synth_failures_skipped.down.sql — undo migration 189.
--
--   bun run src/cli.ts apply-migrations --down 189 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 189_synth_failures_skipped.down.sql
--
-- Deletes the `skipped` rows (those transcripts become eligible for the
-- reflections phase again) and narrows the kind check back. It refuses, and
-- changes nothing, unless 189 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 189 THEN
    RAISE EXCEPTION '189 down: migration 189 is not the latest applied migration';
  END IF;
END
$down$;

DELETE FROM synth_failures WHERE kind = 'skipped';

ALTER TABLE synth_failures
  DROP CONSTRAINT synth_failures_kind_check;

ALTER TABLE synth_failures
  ADD CONSTRAINT synth_failures_kind_check
  CHECK (kind IN ('llm_error', 'unparseable', 'truncated'));

DELETE FROM migrations WHERE id = 189;
