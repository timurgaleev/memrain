SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 186 THEN
    RAISE EXCEPTION '186 down: migration 186 is not the latest applied migration';
  END IF;
  -- Dropping the column would let a floored credential read every tier.
  IF EXISTS (SELECT 1 FROM access_tokens WHERE min_trust IS NOT NULL AND revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM oauth_clients WHERE min_trust IS NOT NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '186 down: credentials hold a read floor; clear it (memrain auth min-trust <name> none) or revoke them first';
  END IF;
END
$down$;

ALTER TABLE oauth_clients DROP COLUMN IF EXISTS min_trust;
ALTER TABLE access_tokens DROP COLUMN IF EXISTS min_trust;
DELETE FROM migrations WHERE id = 186;
