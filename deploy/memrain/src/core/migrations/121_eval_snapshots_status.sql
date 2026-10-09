-- 121_eval_snapshots_status.sql — how a probe run ended.
--
-- The nightly probe (commands/eval-probe.ts) used to write a row only when the
-- replay finished, so a probe that threw left no trace, and a run that a
-- --limit or --max-usd cap cut short read the same as a full one.
--
--   ok      the replay covered the whole eval set
--   capped  a limit stopped it before the end of the eval set
--   error   the replay threw; detail.error holds the message, the scalar
--           columns are zero and measure nothing
--
-- Existing rows were all complete runs as far as anyone can tell, so they
-- take the default.

ALTER TABLE eval_snapshots
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ok';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'eval_snapshots_status_check'
       AND conrelid = 'eval_snapshots'::regclass
  ) THEN
    ALTER TABLE eval_snapshots
      ADD CONSTRAINT eval_snapshots_status_check
      CHECK (status IN ('ok', 'capped', 'error'));
  END IF;
END
$$;
