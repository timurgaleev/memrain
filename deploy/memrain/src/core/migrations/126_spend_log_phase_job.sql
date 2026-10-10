-- 126_spend_log_phase_job.sql — what a paid call was spent ON, and how it ended.
--
-- The ledger knew the feature (operation) and the spender (client_id), but a
-- system call — cycle phase, queued job, CLI — booked client_id NULL with no
-- trace of which phase or job paid for it. These columns make the brain-wide
-- and cycle daily caps measurable and the September bill explainable.
--
--   mcp_spend_log.phase        cycle phase the call ran under; NULL outside one
--   mcp_spend_log.job_id       queued job the call ran under; NULL outside one
--   mcp_spend_log.outcome      ok | error | halted | refused; NULL on rows
--                              booked before this migration
--   mcp_spend_log.latency_ms   time spent in the provider call
--   mcp_spend_reservations.phase
--                              the phase a pending hold counts against, so the
--                              cycle cap sees in-flight cycle calls
--
-- The (created_at) index serves the brain-wide day sum over every spender; the
-- partial one serves the cycle sum, which only reads phase-tagged rows.
-- Additive, catalog-only on Postgres apart from the two index builds.

ALTER TABLE mcp_spend_log
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_spend_log_outcome_check'
       AND conrelid = 'mcp_spend_log'::regclass
  ) THEN
    ALTER TABLE mcp_spend_log
      ADD CONSTRAINT mcp_spend_log_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('ok', 'error', 'halted', 'refused'));
  END IF;
END
$$;

ALTER TABLE mcp_spend_reservations ADD COLUMN IF NOT EXISTS phase TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_created
  ON mcp_spend_log (created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_phase_created
  ON mcp_spend_log (created_at)
  WHERE phase IS NOT NULL;
