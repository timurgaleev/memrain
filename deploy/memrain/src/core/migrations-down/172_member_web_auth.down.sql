SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 172 THEN
    RAISE EXCEPTION '172 down: migration 172 is not the latest applied migration';
  END IF;
  -- Dropping the table would lock every member out of /app with no way back
  -- except a fresh invite each, so the operator clears the passkeys first.
  IF EXISTS (SELECT 1 FROM member_passkeys) THEN
    RAISE EXCEPTION '172 down: member passkeys exist; delete them first';
  END IF;
END
$down$;

DROP TABLE IF EXISTS member_web_sessions;
DROP TABLE IF EXISTS member_invites;
DROP TABLE IF EXISTS member_passkeys;
DELETE FROM migrations WHERE id = 172;
