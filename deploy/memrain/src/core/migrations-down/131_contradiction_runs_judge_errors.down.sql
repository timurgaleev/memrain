-- 131_contradiction_runs_judge_errors.down.sql — undo migration 131.
--
--   bun run src/cli.ts apply-migrations --down 131 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 131_contradiction_runs_judge_errors.down.sql
--
-- Drops the three judge-failure columns from synth_contradiction_runs and
-- 131's migrations row. The run rows themselves stay: their found/judged
-- counts and intervals read the same without the columns. It refuses, and
-- changes nothing, unless 131 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 131 THEN
    RAISE EXCEPTION '131 down: migration 131 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE synth_contradiction_runs DROP COLUMN judge_failed;
ALTER TABLE synth_contradiction_runs DROP COLUMN parse_failures;
ALTER TABLE synth_contradiction_runs DROP COLUMN judge_errors;

DELETE FROM migrations WHERE id = 131;
