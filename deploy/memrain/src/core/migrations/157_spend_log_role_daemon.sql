-- 157_spend_log_role_daemon.sql — the spend wallet's attribution and pauses.
--
-- Each paid call is now spent ON a path (`role`: facts-extract, deep-synth,
-- connector_sync, ...) and, when a daemon runs it, FOR a daemon and the source
-- that run serves. Those are the keys the wallet's day caps sum over, so both
-- the actuals and the in-flight holds carry them.
--
--   mcp_spend_log.role / daemon / daemon_source
--   mcp_spend_reservations.role / daemon / daemon_source
--                          NULL on calls made outside any wallet path and on
--                          every row booked before this migration
--   mcp_spend_log.overrun_cents
--                          the part of a call's actual cost above the hold
--                          set aside for it. A hold is the call's maximum
--                          possible cost, so this is an accounting error, not
--                          spend the cap allowed: day sums count
--                          spend_cents - overrun_cents, so a wrong estimate
--                          cannot carry a counter past its cap. The full
--                          actual stays in spend_cents.
--   spend_path_pauses      a path whose call overran its hold. Its next calls
--                          are refused until the operator resolves the row;
--                          at most one open row per path.
--
-- Additive: older code never reads the new columns, and a NULL overrun leaves
-- every existing sum unchanged.

ALTER TABLE mcp_spend_log
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS daemon TEXT,
  ADD COLUMN IF NOT EXISTS daemon_source TEXT,
  ADD COLUMN IF NOT EXISTS overrun_cents NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_spend_log_overrun_check'
       AND conrelid = 'mcp_spend_log'::regclass
  ) THEN
    ALTER TABLE mcp_spend_log
      ADD CONSTRAINT mcp_spend_log_overrun_check
      CHECK (overrun_cents IS NULL OR overrun_cents >= 0);
  END IF;
END
$$;

ALTER TABLE mcp_spend_reservations
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS daemon TEXT,
  ADD COLUMN IF NOT EXISTS daemon_source TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_role_created
  ON mcp_spend_log (role, created_at)
  WHERE role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_daemon_created
  ON mcp_spend_log (daemon, created_at)
  WHERE daemon IS NOT NULL;

CREATE TABLE IF NOT EXISTS spend_path_pauses (
  id            BIGSERIAL PRIMARY KEY,
  path          TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 100),
  reason        TEXT NOT NULL CHECK (length(reason) <= 500),
  model         TEXT,
  held_cents    NUMERIC,
  actual_cents  NUMERIC,
  paused_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS spend_path_pauses_open_idx
  ON spend_path_pauses (path)
  WHERE resolved_at IS NULL;
