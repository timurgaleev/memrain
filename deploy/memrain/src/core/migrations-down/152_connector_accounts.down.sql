SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE connector_accounts, connector_credentials, connector_oauth_clients IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 152 THEN
    RAISE EXCEPTION '152 down: migration 152 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM connector_accounts) THEN
    RAISE EXCEPTION '152 down: connector accounts must be disconnected first';
  END IF;
  IF EXISTS (SELECT 1 FROM connector_oauth_clients) THEN
    RAISE EXCEPTION '152 down: stored oauth clients must be removed first';
  END IF;
END
$down$;

DROP TABLE connector_credentials;
DROP TABLE connector_oauth_clients;
DROP TABLE connector_accounts;
DELETE FROM migrations WHERE id = 152;
