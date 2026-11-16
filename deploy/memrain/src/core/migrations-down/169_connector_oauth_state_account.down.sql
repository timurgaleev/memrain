SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 169 THEN
    RAISE EXCEPTION '169 down: migration 169 is not the latest applied migration';
  END IF;
END
$down$;

-- A reconnect started before the down finishes as a plain connect: by the
-- row's address, as before 169.
ALTER TABLE connector_oauth_states DROP COLUMN IF EXISTS account_id;
DELETE FROM migrations WHERE id = 169;
