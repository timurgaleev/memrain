SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 164 THEN
    RAISE EXCEPTION '164 down: migration 164 is not the latest applied migration';
  END IF;
  -- Dropping the column would widen a narrowed credential to every tool.
  IF EXISTS (SELECT 1 FROM access_tokens WHERE tool_surface <> 'full' AND revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM oauth_clients WHERE tool_surface <> 'full' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '164 down: credentials hold a narrowed tool surface; set them back to full or revoke them first';
  END IF;
END
$down$;

ALTER TABLE oauth_clients DROP COLUMN IF EXISTS tool_surface;
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS profile_catalog_version;
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS profile;
ALTER TABLE access_tokens DROP COLUMN IF EXISTS tool_surface;
ALTER TABLE access_tokens DROP COLUMN IF EXISTS profile_catalog_version;
ALTER TABLE access_tokens DROP COLUMN IF EXISTS profile;
DELETE FROM migrations WHERE id = 164;
