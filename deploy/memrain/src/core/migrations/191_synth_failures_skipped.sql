-- 191_synth_failures_skipped.sql — a synthesis phase can record "nothing here".
--
-- The reflections phase sends recent transcripts that no reflection cites yet.
-- When the model answers that nothing is worth reflecting on, nothing marked
-- those transcripts, so every run paid to send them again. A `skipped` row
-- records that answer for the transcript's content hash and model, with
-- next_eligible_at = 'infinity'; an edit or a model switch makes the
-- transcript eligible again, as for every other synth_failures row.
ALTER TABLE synth_failures
  DROP CONSTRAINT IF EXISTS synth_failures_kind_check;

ALTER TABLE synth_failures
  ADD CONSTRAINT synth_failures_kind_check
  CHECK (kind IN ('llm_error', 'unparseable', 'truncated', 'skipped'));
