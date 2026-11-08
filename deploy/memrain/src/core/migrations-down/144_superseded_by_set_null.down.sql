SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 144 THEN
    RAISE EXCEPTION '144 down: migration 144 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE entity_facts DROP CONSTRAINT IF EXISTS entity_facts_superseded_by_fkey;
ALTER TABLE entity_facts ADD CONSTRAINT entity_facts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES entity_facts(id);
DELETE FROM migrations WHERE id = 144;
