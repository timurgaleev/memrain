SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE connector_oauth_states IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 154 THEN
    RAISE EXCEPTION '154 down: migration 154 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM connector_oauth_states WHERE consumed_at IS NULL AND expires_at > NOW()) THEN
    RAISE EXCEPTION '154 down: a connector connect is still pending';
  END IF;
END
$down$;

DROP TABLE connector_oauth_states;
DELETE FROM migrations WHERE id = 154;
