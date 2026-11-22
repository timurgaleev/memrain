-- 192_trust_forget_proposals.down.sql — undo migration 192.
--
--   bun run src/cli.ts apply-migrations --down 192 --yes
--
-- Refuses while a forget proposal awaits a decision. Decided forget proposals
-- go; the facts they named stay as they are.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 192 THEN
    RAISE EXCEPTION '192 down: migration 192 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM trust_proposals WHERE action = 'forget' AND status = 'pending') THEN
    RAISE EXCEPTION '192 down: forget proposals await a decision; accept or reject them first (memrain trust proposals)';
  END IF;
END
$down$;

DELETE FROM trust_proposals WHERE action = 'forget';
DROP INDEX IF EXISTS trust_proposals_pending_forget_idx;
ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_forget_shape;
ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_guard_check;
ALTER TABLE trust_proposals ADD CONSTRAINT trust_proposals_guard_check CHECK (guard IN ('conflict', 'replaces', 'ontology'));
ALTER TABLE trust_proposals DROP CONSTRAINT IF EXISTS trust_proposals_action_check;
ALTER TABLE trust_proposals ADD CONSTRAINT trust_proposals_action_check CHECK (action IN ('supersede_fact'));
ALTER TABLE trust_proposals ALTER COLUMN related_id SET NOT NULL;
DELETE FROM migrations WHERE id = 192;
