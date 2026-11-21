-- 179_write_gate_receipts.sql — what the write gate flagged on facts, takes
-- and timeline entries.
--
-- Documents already pass the write gate in the indexer (migration 159 holds
-- what it quarantines). Facts, takes and timeline entries written by an agent
-- or drawn from an outside source are now checked too, in flag mode only: the
-- row is stored and served exactly as before, and a receipt here records that
-- its text reads as instructions to an AI. A receipt names the families that
-- matched and a hash of the assessed text, never the text itself, so it is
-- safe to keep after the row it names is gone.
--
-- One receipt per row, content and detector version: the same row re-written
-- with the same text bumps `seen_count` instead of adding another.
CREATE TABLE IF NOT EXISTS write_gate_receipts (
  id               BIGSERIAL PRIMARY KEY,
  target_table     TEXT NOT NULL CHECK (target_table IN ('entity_facts', 'synth_takes', 'timeline_events')),
  target_id        TEXT NOT NULL,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  origin           TEXT NOT NULL CHECK (origin IN ('external', 'agent')),
  verdict          TEXT NOT NULL CHECK (verdict IN ('flag')),
  reason_families  TEXT[] NOT NULL,
  detector_version TEXT NOT NULL,
  detector_error   BOOLEAN NOT NULL DEFAULT FALSE,
  binding          TEXT NOT NULL,
  seen_count       INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS write_gate_receipts_target_idx
  ON write_gate_receipts (target_table, target_id, binding, detector_version);

CREATE INDEX IF NOT EXISTS write_gate_receipts_source_created_idx
  ON write_gate_receipts (source_id, created_at);
