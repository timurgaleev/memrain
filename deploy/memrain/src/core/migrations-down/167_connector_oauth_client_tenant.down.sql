SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 167 THEN
    RAISE EXCEPTION '167 down: migration 167 is not the latest applied migration';
  END IF;
END
$down$;

-- A client saved with a tenant falls back to the provider's default; the
-- operator saves it again after the next up if the app is single-tenant.
ALTER TABLE connector_oauth_clients DROP COLUMN IF EXISTS tenant;
DELETE FROM migrations WHERE id = 167;
