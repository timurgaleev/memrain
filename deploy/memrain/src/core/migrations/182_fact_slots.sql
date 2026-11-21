-- 182_fact_slots.sql — fact slots and when a fact was first written.
--
-- A fact about a person may carry one slot: where they live (location), who
-- employs them (employer) or their role. Nothing closes a slot value in
-- storage; readers work out at read time that a later value of the same slot
-- ended an earlier one, from the facts that reader may see. Only new
-- extractions are tagged; existing rows keep NULL.
--
-- first_written_at is when the brain first heard a claim. written_at moves on
-- every restatement, so a "what did the brain know as of T" read needs the
-- first time. New rows get it from the default; an existing row gets it the
-- next time it is restated (from its written_at at that moment), and rows
-- never restated keep NULL and read their written_at. No row is backfilled.

ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS slot_dimension TEXT
  CHECK (slot_dimension IS NULL OR slot_dimension IN ('location', 'employer', 'role'));
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS slot_value TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS slot_value_hash TEXT;
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS first_written_at TIMESTAMPTZ;
-- A separate statement, so existing rows stay NULL instead of taking the
-- migration's own timestamp.
ALTER TABLE entity_facts ALTER COLUMN first_written_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_entity_facts_slot
  ON entity_facts (source_id, entity_slug, slot_dimension)
  WHERE slot_dimension IS NOT NULL;
