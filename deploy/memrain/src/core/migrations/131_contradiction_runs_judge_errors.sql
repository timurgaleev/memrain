-- 131_contradiction_runs_judge_errors.sql — judge failures on the probe's trend row.
--
-- A contradiction-probe run used to drop a judge call that threw from every
-- count, and to count a reply with no parseable verdict as a judged negative.
-- Both now land on the run row so its rate can be read for what it is:
--
--   judge_errors    judge calls that threw (gateway error, refusal, timeout)
--   parse_failures  judge replies that held no parseable verdict; these are
--                   neither negatives nor part of `judged`
--   judge_failed    more than a quarter of the run's judge calls returned no
--                   verdict, so its contradiction rate is not trustworthy
--
-- Rows written before this migration recorded neither, so they take zero and
-- false.

ALTER TABLE synth_contradiction_runs
  ADD COLUMN IF NOT EXISTS judge_errors INTEGER NOT NULL DEFAULT 0;

ALTER TABLE synth_contradiction_runs
  ADD COLUMN IF NOT EXISTS parse_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE synth_contradiction_runs
  ADD COLUMN IF NOT EXISTS judge_failed BOOLEAN NOT NULL DEFAULT false;
