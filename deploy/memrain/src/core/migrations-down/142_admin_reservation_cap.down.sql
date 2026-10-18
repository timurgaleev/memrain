-- 142_admin_reservation_cap.down.sql — undo migration 142.
--
--   bun run src/cli.ts apply-migrations --down 142 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 142_admin_reservation_cap.down.sql
--
-- Drops the reservation counters and 142's migrations row. Links and codes
-- stay; an older release reserves them without a cap again.
-- It refuses, and changes nothing, unless 142 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 142 THEN
    RAISE EXCEPTION '142 down: migration 142 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE admin_setup_links DROP COLUMN IF EXISTS reservations;
ALTER TABLE admin_recovery_codes DROP COLUMN IF EXISTS reservations;

DELETE FROM migrations WHERE id = 142;
