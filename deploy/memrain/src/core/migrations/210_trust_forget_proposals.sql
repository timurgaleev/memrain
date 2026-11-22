-- 210_trust_forget_proposals.sql — an agent cannot forget a more trusted fact.
--
-- A forget withdraws the claim (migration 112), so a later insert of it lands
-- forgotten: a stronger override than a supersession. When a remote caller
-- asks to forget a fact whose tier is higher than its own, the fact stays and
-- a `forget` proposal waits for the owner (core/trust-proposals.ts). It names
-- the fact only; accepting it applies the forget.
ALTER TABLE trust_proposals ALTER COLUMN related_id DROP NOT NULL;

ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_action_check;
ALTER TABLE trust_proposals ADD CONSTRAINT trust_proposals_action_check CHECK (action IN ('supersede_fact', 'forget'));

ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_guard_check;
ALTER TABLE trust_proposals ADD CONSTRAINT trust_proposals_guard_check CHECK (guard IN ('conflict', 'replaces', 'ontology', 'remote_forget'));

ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_forget_shape;
ALTER TABLE trust_proposals ADD CONSTRAINT trust_proposals_forget_shape
  CHECK ((action = 'forget') = (related_id IS NULL) AND (action = 'forget') = (guard = 'remote_forget'));

-- One pending forget per fact: a retried forget reuses it.
CREATE UNIQUE INDEX IF NOT EXISTS trust_proposals_pending_forget_idx
  ON trust_proposals (target_id) WHERE status = 'pending' AND action = 'forget';
