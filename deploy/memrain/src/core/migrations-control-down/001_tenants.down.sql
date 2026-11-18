SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'control 001 down: migration 1 is not the latest applied migration';
  END IF;
  -- The table is the only record of which databases and roles belong to whom.
  IF EXISTS (SELECT 1 FROM tenants) THEN
    RAISE EXCEPTION 'control 001 down: tenants exist; purge them first';
  END IF;
END
$down$;

DROP TABLE IF EXISTS tenant_events;
DROP TABLE IF EXISTS tenants;
DELETE FROM migrations WHERE id = 1;
