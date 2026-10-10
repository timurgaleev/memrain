-- 126_spend_log_phase_job.down.sql — undo migration 126.
--
--   bun run src/cli.ts apply-migrations --down 126 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 126_spend_log_phase_job.down.sql
--
-- Drops the attribution columns, the outcome check, both indexes and 126's
-- migrations row. Every ledger row is kept: an older release reads spend_cents
-- and never looked at these columns. The $0 'refused' rows stay too and read as
-- free calls that reported no usage, which is what they were. It refuses, and
-- changes nothing, unless 126 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 126 THEN
    RAISE EXCEPTION '126 down: migration 126 is not the latest applied migration';
  END IF;
END
$down$;

DROP INDEX IF EXISTS idx_mcp_spend_log_phase_created;
DROP INDEX IF EXISTS idx_mcp_spend_log_created;
ALTER TABLE mcp_spend_reservations DROP COLUMN IF EXISTS phase;
ALTER TABLE mcp_spend_log DROP CONSTRAINT IF EXISTS mcp_spend_log_outcome_check;
ALTER TABLE mcp_spend_log
  DROP COLUMN IF EXISTS latency_ms,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS job_id,
  DROP COLUMN IF EXISTS phase;

DELETE FROM migrations WHERE id = 126;
