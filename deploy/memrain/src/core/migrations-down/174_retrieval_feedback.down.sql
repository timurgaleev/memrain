SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 174 THEN
    RAISE EXCEPTION '174 down: migration 174 is not the latest applied migration';
  END IF;
END
$down$;

-- Search ranks without feedback again; nothing else points at these tables.
DROP TABLE IF EXISTS retrieval_weights;
DROP TABLE IF EXISTS retrieval_feedback;
DELETE FROM migrations WHERE id = 174;
