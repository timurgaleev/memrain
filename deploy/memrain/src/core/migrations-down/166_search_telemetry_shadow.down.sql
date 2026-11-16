SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 166 THEN
    RAISE EXCEPTION '166 down: migration 166 is not the latest applied migration';
  END IF;
END
$down$;

-- Aggregates only; a shadow run after an up starts the counts again.
DROP TABLE IF EXISTS search_telemetry_shadow;
DELETE FROM migrations WHERE id = 166;
