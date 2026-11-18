SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'control 008 down: migration 8 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE tenant_exports DROP COLUMN IF EXISTS sha256;
DELETE FROM migrations WHERE id = 8;
