SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 179 THEN
    RAISE EXCEPTION '179 down: migration 179 is not the latest applied migration';
  END IF;
END
$down$;

-- Only receipts go: the facts, takes and timeline entries they name are untouched.
DROP TABLE IF EXISTS write_gate_receipts;
DELETE FROM migrations WHERE id = 179;
