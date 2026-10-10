-- 129_synth_failures.sql — failure backoff for per-document synthesis, and an
-- `extracted` watermark for the conversation-facts backfill.
--
-- synth_failures: propose_takes and extract_atoms memoize a document only once
-- the model answers cleanly. A document whose call throws, or whose answer
-- never parses, stayed eligible, so every cycle paid for it again — and since
-- discovery is recency-ordered, a few such documents could hold every slot.
-- One row per (document, phase) records the failure; discovery skips the
-- document until next_eligible_at. The wait doubles per consecutive failure
-- (24h, 48h, 96h ...) and stops growing at 7 days. A row whose content_hash or
-- model no longer matches is ignored, and the next failure restarts the count
-- at 1: an edited note or a model switch is a new question, not a repeat. A
-- clean answer deletes the row. No FK to documents: a purged document's row is
-- harmless, and a changed body never matches it.
CREATE TABLE IF NOT EXISTS synth_failures (
  doc_id            TEXT NOT NULL,
  phase             TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  model             TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  kind              TEXT NOT NULL CHECK (kind IN ('llm_error', 'unparseable', 'truncated')),
  next_eligible_at  TIMESTAMPTZ NOT NULL,
  last_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, phase)
);

-- facts_backfill_scans: the backfill treated any page with an on-write fact row
-- as done for good, so an edited page was never extracted again. An `extracted`
-- row records the content hash a successful extraction read; a later edit
-- changes the hash and re-opens the page.
ALTER TABLE facts_backfill_scans
  DROP CONSTRAINT IF EXISTS facts_backfill_scans_outcome_check;

ALTER TABLE facts_backfill_scans
  ADD CONSTRAINT facts_backfill_scans_outcome_check
  CHECK (outcome IN ('zero_yield', 'extracted'));
