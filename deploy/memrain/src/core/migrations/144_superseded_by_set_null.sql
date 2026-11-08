ALTER TABLE entity_facts DROP CONSTRAINT IF EXISTS entity_facts_superseded_by_fkey;
ALTER TABLE entity_facts ADD CONSTRAINT entity_facts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES entity_facts(id) ON DELETE SET NULL;
