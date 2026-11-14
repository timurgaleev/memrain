SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE entity_facts IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 149 THEN
    RAISE EXCEPTION '149 down: migration 149 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM entity_facts WHERE forgotten_cause = 'purge') THEN
    RAISE EXCEPTION '149 down: facts retired by a page purge must keep their purge cause';
  END IF;
END
$down$;

ALTER TABLE entity_facts DROP CONSTRAINT entity_facts_forgotten_cause_chk;
ALTER TABLE entity_facts
  ADD CONSTRAINT entity_facts_forgotten_cause_chk
  CHECK (forgotten_cause IS NULL
         OR forgotten_cause IN ('forget', 'supersede', 'consolidate'));
DELETE FROM migrations WHERE id = 149;
