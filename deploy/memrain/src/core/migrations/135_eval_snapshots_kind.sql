-- 135_eval_snapshots_kind.sql — who wrote an eval snapshot.
--
-- eval_snapshots held only the nightly probe's rows, and its readers (doctor's
-- trend, the eval-blind advisor) take the newest row as the probe's latest.
-- `memrain eval --record` now appends its A/B results to the same table, so a
-- row says which kind it is:
--
--   probe  the nightly probe (commands/eval-probe.ts)
--   ab     a recorded A/B run; detail holds the receipt and paired statistics
--   gate   reserved for recorded regression-gate runs
--
-- Every existing row was written by the probe, so it takes the default.

ALTER TABLE eval_snapshots
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'probe';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'eval_snapshots_kind_check'
       AND conrelid = 'eval_snapshots'::regclass
  ) THEN
    ALTER TABLE eval_snapshots
      ADD CONSTRAINT eval_snapshots_kind_check
      CHECK (kind IN ('probe', 'ab', 'gate'));
  END IF;
END
$$;
