SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 187 THEN
    RAISE EXCEPTION '187 down: migration 187 is not the latest applied migration';
  END IF;
END
$down$;

-- Dropping the hash only loses reuse precision: the indexer treats a vector
-- without one by the text, model and width rule.
ALTER TABLE embeddings DROP COLUMN IF EXISTS input_hash;
DELETE FROM migrations WHERE id = 187;
