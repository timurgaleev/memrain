-- 171_chat_evidence_tier.sql — the trust of everything an answer was written from.
--
-- An answer's model reads every page and take the turn gathered, not only
-- the ones it cites, so an answer can restate outside text (a synced mailbox,
-- a Slack channel) while citing an owner page. `evidence_tier` records the
-- least trusted tier among all of that evidence when the answer is stored;
-- saving the answer as a page caps the page's tier with it. NULL is an answer
-- stored before this column, whose evidence is unknown: it saves as external.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS evidence_tier TEXT NULL
    CHECK (evidence_tier IS NULL OR evidence_tier IN ('owner', 'member', 'agent', 'external'));
