SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 185 THEN
    RAISE EXCEPTION '185 down: migration 185 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM trust_proposals WHERE status = 'pending') THEN
    RAISE EXCEPTION '185 down: trust proposals await a decision; accept or reject them first (memrain trust proposals)';
  END IF;
END
$down$;

-- Decided proposals go; every fact they named stays as it is.
DROP TABLE IF EXISTS trust_proposals;
DELETE FROM migrations WHERE id = 185;
