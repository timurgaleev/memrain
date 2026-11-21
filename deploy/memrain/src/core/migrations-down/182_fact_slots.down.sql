SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 182 THEN
    RAISE EXCEPTION '182 down: migration 182 is not the latest applied migration';
  END IF;
END
$down$;

-- Fact text is untouched; only the slot tags and first-written times go.
DROP INDEX IF EXISTS idx_entity_facts_slot;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS slot_dimension;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS slot_value;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS slot_value_hash;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS first_written_at;
DELETE FROM migrations WHERE id = 182;
