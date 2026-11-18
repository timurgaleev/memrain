SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 171 THEN
    RAISE EXCEPTION '171 down: migration 171 is not the latest applied migration';
  END IF;
END
$down$;

-- Saving an answer then caps its page by the evidence it cites, as before 171.
ALTER TABLE chat_messages DROP COLUMN IF EXISTS evidence_tier;
DELETE FROM migrations WHERE id = 171;
