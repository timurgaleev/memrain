SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 180 THEN
    RAISE EXCEPTION '180 down: migration 180 is not the latest applied migration';
  END IF;
END
$down$;

-- The kept originals go with the tables; pages keep their markers.
DROP TABLE IF EXISTS secret_store_occurrences;
DROP TABLE IF EXISTS secret_store;
DELETE FROM migrations WHERE id = 180;
