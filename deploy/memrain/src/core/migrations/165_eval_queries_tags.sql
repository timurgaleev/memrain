-- 165_eval_queries_tags.sql — labels for the live eval set.
--
-- The admin labelling screen turns a captured (scrubbed) query into an
-- eval_queries row: the operator marks every document that answers it, and
-- tags it so a report can break metrics down by intent, language and kind.
--
--   tags              short labels such as 'intent:topic' or 'kind:alias'
--   lang              two-letter language of the query
--   split             'dev' (tuned against) or 'sealed' (scored once per
--                     pre-registration); NULL reads as dev
--   expected_doc_ids  every relevant document id; expected_doc_id keeps the
--                     first one for the replay harness, which scores one
--   candidate_id      the eval_candidates row the label came from, so a
--                     candidate is labelled once and drops off the screen.
--                     No foreign key: candidates are pruned on their own
--                     schedule and the label outlives them.
--
-- Every column is optional, so rows written before 165 stay valid.

ALTER TABLE eval_queries ADD COLUMN IF NOT EXISTS tags TEXT[]
  CHECK (tags IS NULL OR cardinality(tags) <= 16);
ALTER TABLE eval_queries ADD COLUMN IF NOT EXISTS lang TEXT
  CHECK (lang IS NULL OR lang ~ '^[a-z]{2}$');
ALTER TABLE eval_queries ADD COLUMN IF NOT EXISTS split TEXT
  CHECK (split IS NULL OR split IN ('dev', 'sealed'));
ALTER TABLE eval_queries ADD COLUMN IF NOT EXISTS expected_doc_ids JSONB
  CHECK (expected_doc_ids IS NULL OR jsonb_typeof(expected_doc_ids) = 'array');
ALTER TABLE eval_queries ADD COLUMN IF NOT EXISTS candidate_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS eval_queries_candidate_idx
  ON eval_queries (candidate_id) WHERE candidate_id IS NOT NULL;
