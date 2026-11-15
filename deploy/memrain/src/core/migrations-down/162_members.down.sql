SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 162 THEN
    RAISE EXCEPTION '162 down: migration 162 is not the latest applied migration';
  END IF;
  -- Dropping the table would silently re-enable every credential of a
  -- disabled or removed member, so the operator clears the members first.
  IF EXISTS (SELECT 1 FROM members) THEN
    RAISE EXCEPTION '162 down: members exist; unbind their credentials and delete the members first';
  END IF;
END
$down$;

DROP TABLE IF EXISTS member_audit;
ALTER TABLE oauth_enrollments DROP COLUMN IF EXISTS member_id;
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS member_id;
ALTER TABLE access_tokens DROP COLUMN IF EXISTS member_id;
DROP TABLE IF EXISTS members;
DELETE FROM migrations WHERE id = 162;
