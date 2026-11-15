SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 165 THEN
    RAISE EXCEPTION '165 down: migration 165 is not the latest applied migration';
  END IF;
END
$down$;

-- The labelled queries stay; their tags, language, split, extra relevant ids
-- and candidate link go. expected_doc_id still carries the first relevant id.
DROP INDEX IF EXISTS eval_queries_candidate_idx;
ALTER TABLE eval_queries DROP COLUMN IF EXISTS candidate_id;
ALTER TABLE eval_queries DROP COLUMN IF EXISTS expected_doc_ids;
ALTER TABLE eval_queries DROP COLUMN IF EXISTS split;
ALTER TABLE eval_queries DROP COLUMN IF EXISTS lang;
ALTER TABLE eval_queries DROP COLUMN IF EXISTS tags;
DELETE FROM migrations WHERE id = 165;
