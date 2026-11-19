SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE write_gate_holds IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 159 THEN
    RAISE EXCEPTION '159 down: migration 159 is not the latest applied migration';
  END IF;
  -- An open hold is a hidden document the owner has not reviewed yet; dropping
  -- the queue would leave it hidden with nothing pointing at it.
  IF EXISTS (SELECT 1 FROM write_gate_holds WHERE decision IS NULL) THEN
    RAISE EXCEPTION '159 down: write-gate holds are awaiting a decision; approve or reject them first';
  END IF;
END
$down$;

DROP TABLE write_gate_holds;
DELETE FROM migrations WHERE id = 159;
