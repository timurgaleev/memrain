SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'control 002 down: migration 2 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS tenant_exports;
DELETE FROM migrations WHERE id = 2;
