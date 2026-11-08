SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 145 THEN
    RAISE EXCEPTION '145 down: migration 145 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE synth_concepts DROP COLUMN IF EXISTS member_hash;
DELETE FROM migrations WHERE id = 145;
