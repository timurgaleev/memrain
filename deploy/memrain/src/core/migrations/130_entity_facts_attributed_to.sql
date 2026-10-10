-- 130_entity_facts_attributed_to.sql — who asserted a fact.
--
-- The extractor reads conversations between the operator and an assistant.
-- Without a speaker, an assistant's recommendation was stored exactly like the
-- operator's own preference. attributed_to records who said it:
--
--   user       the operator (or the user side of the conversation)
--   assistant  the assistant — a recommendation, answer or plan
--   other      a named third party
--   NULL       not recorded: every row written before this migration, every
--              manual add_fact and every consolidated take
--
-- It joins the claim identity (facts.ts findLiveClaim), so an assistant's claim
-- never refreshes the operator's claim of the same words. No backfill: an old
-- row's speaker is unknown, and NULL says so.

ALTER TABLE entity_facts
  ADD COLUMN IF NOT EXISTS attributed_to TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'entity_facts_attributed_to_check'
       AND conrelid = 'entity_facts'::regclass
  ) THEN
    ALTER TABLE entity_facts
      ADD CONSTRAINT entity_facts_attributed_to_check
      CHECK (attributed_to IS NULL OR attributed_to IN ('user', 'assistant', 'other'));
  END IF;
END
$$;
