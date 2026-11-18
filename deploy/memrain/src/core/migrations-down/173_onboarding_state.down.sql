SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 173 THEN
    RAISE EXCEPTION '173 down: migration 173 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS onboarding_state;
DELETE FROM migrations WHERE id = 173;
