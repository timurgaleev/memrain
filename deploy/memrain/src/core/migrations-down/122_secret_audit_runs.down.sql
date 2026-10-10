-- 122_secret_audit_runs.down.sql — undo migration 122.
--
--   bun run src/cli.ts apply-migrations --down 122 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 122_secret_audit_runs.down.sql
--
-- Drops the audit-run table and page_versions.scrubbed_at, then 122's
-- migrations row. Snapshots an audit already rewrote stay rewritten: the
-- credential they held is gone, and an older release reads them as ordinary
-- versions. It refuses, and changes nothing, unless 122 is the latest
-- migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 122 THEN
    RAISE EXCEPTION '122 down: migration 122 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE page_versions DROP COLUMN IF EXISTS scrubbed_at;
DROP INDEX IF EXISTS idx_secret_audit_runs_finished;
DROP TABLE IF EXISTS secret_audit_runs;

DELETE FROM migrations WHERE id = 122;
