-- 141_admin_passkeys.down.sql — undo migration 141.
--
--   bun run src/cli.ts apply-migrations --down 141 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 141_admin_passkeys.down.sql
--
-- Drops the five passkey tables and 141's migrations row. Every passkey,
-- recovery code, setup link and sign-in event is lost; the bootstrap token and
-- magic links keep working. It refuses, and changes nothing, unless 141 is the
-- latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 141 THEN
    RAISE EXCEPTION '141 down: migration 141 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS admin_auth_events;
DROP TABLE IF EXISTS admin_setup_links;
DROP TABLE IF EXISTS admin_recovery_codes;
DROP TABLE IF EXISTS admin_passkeys;
DROP TABLE IF EXISTS admin_owner;

DELETE FROM migrations WHERE id = 141;
