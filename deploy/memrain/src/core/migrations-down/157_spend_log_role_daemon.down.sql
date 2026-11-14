-- 157_spend_log_role_daemon.down.sql — undo migration 157.
--
--   bun run src/cli.ts apply-migrations --down 157 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 157_spend_log_role_daemon.down.sql
--
-- Drops the wallet attribution columns, the overrun column and its check, both
-- indexes, the paused-path table and 157's migrations row. Every ledger row is
-- kept; an older release reads spend_cents, which always held the full actual.
-- It refuses, and changes nothing, unless 157 is the latest migration and no
-- path is still paused: an open pause stops a path that overran its hold, and
-- dropping it would let that path spend again without the operator looking.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 157 THEN
    RAISE EXCEPTION '157 down: migration 157 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM spend_path_pauses WHERE resolved_at IS NULL) THEN
    RAISE EXCEPTION '157 down: a spend path is still paused after an overrun; resolve it first (memrain spend resume <path>)';
  END IF;
END
$down$;

DROP TABLE spend_path_pauses;
DROP INDEX IF EXISTS idx_mcp_spend_log_daemon_created;
DROP INDEX IF EXISTS idx_mcp_spend_log_role_created;
ALTER TABLE mcp_spend_reservations
  DROP COLUMN IF EXISTS daemon_source,
  DROP COLUMN IF EXISTS daemon,
  DROP COLUMN IF EXISTS role;
ALTER TABLE mcp_spend_log DROP CONSTRAINT IF EXISTS mcp_spend_log_overrun_check;
ALTER TABLE mcp_spend_log
  DROP COLUMN IF EXISTS overrun_cents,
  DROP COLUMN IF EXISTS daemon_source,
  DROP COLUMN IF EXISTS daemon,
  DROP COLUMN IF EXISTS role;

DELETE FROM migrations WHERE id = 157;
