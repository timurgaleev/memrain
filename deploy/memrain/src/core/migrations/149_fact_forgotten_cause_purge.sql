-- 149_fact_forgotten_cause_purge.sql — admit 'purge' as a tombstone cause.
--
-- A hard page purge retires the facts written on that page: once the page row
-- is gone nothing hides them any more, and a later page on the same slug would
-- inherit them. 'purge' keeps those tombstones apart from an operator 'forget'
-- (which also withdraws the claim brain-wide) and from the automatic causes.
--
-- Recreates the CHECK migration 097 left in place, guarded on the live
-- definition already naming 'purge' so a re-run changes nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_forgotten_cause_chk'
       AND conrelid = 'entity_facts'::regclass
       AND pg_get_constraintdef(oid) LIKE '%''purge''%'
  ) THEN
    ALTER TABLE entity_facts DROP CONSTRAINT IF EXISTS entity_facts_forgotten_cause_chk;
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_forgotten_cause_chk
      CHECK (forgotten_cause IS NULL
             OR forgotten_cause IN ('forget', 'supersede', 'consolidate', 'purge'));
  END IF;
END $$;
