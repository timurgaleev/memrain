-- 185_trust_proposals.sql — a less trusted write never silently replaces a
-- more trusted fact.
--
-- When a write would supersede a fact or close an ontology value whose tier is
-- higher than its own (core/trust-tier.ts: owner > member > agent > external),
-- the old fact stays as it was, the new one is stored beside it (an ontology
-- value as quarantined, so it is not read as current), and a proposal here
-- links the two. The owner accepts (the replacement is applied as the writer
-- asked) or rejects it (the lower-tier fact is retired in favour of the old
-- one), with `memrain trust` or on the admin Approvals page.
--
-- before_state holds ids and tiers only, never fact text. One pending proposal
-- per pair: a retried write reuses it.
CREATE TABLE IF NOT EXISTS trust_proposals (
  id                 BIGSERIAL PRIMARY KEY,
  action             TEXT NOT NULL CHECK (action IN ('supersede_fact')),
  guard              TEXT NOT NULL CHECK (guard IN ('conflict', 'replaces', 'ontology')),
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_id          BIGINT NOT NULL REFERENCES entity_facts(id) ON DELETE CASCADE,
  related_id         BIGINT NOT NULL REFERENCES entity_facts(id) ON DELETE CASCADE,
  before_state       JSONB NOT NULL,
  proposer_principal TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ,
  decided_by         TEXT,
  CHECK (target_id <> related_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS trust_proposals_pending_pair_idx
  ON trust_proposals (target_id, related_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS trust_proposals_status_idx
  ON trust_proposals (status, id);

CREATE INDEX IF NOT EXISTS trust_proposals_related_idx
  ON trust_proposals (related_id);
