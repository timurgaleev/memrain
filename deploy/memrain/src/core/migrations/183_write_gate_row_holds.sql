-- 183_write_gate_row_holds.sql — facts, takes and timeline entries the write
-- gate held for the owner.
--
-- With MEMRAIN_WRITE_GATE_ROWS=quarantine, a row an agent wrote or one drawn
-- from an outside source whose text reads as instructions to an AI is not
-- stored in entity_facts, synth_takes or timeline_events. It waits here, as
-- the row its writer would have inserted (`payload`), so no reader of those
-- tables needs a filter. The owner releases it (the row is inserted as
-- written, still flagged) or drops it (kept as a decided record).
--
-- One hold per source, kind, slug, normalized text and detector version: the
-- same content arriving again bumps `seen_count`. A dropped hold stays
-- dropped; content of a released hold is stored when it arrives again.
CREATE TABLE IF NOT EXISTS write_gate_row_holds (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('fact', 'take', 'timeline')),
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL DEFAULT '',
  fingerprint        TEXT NOT NULL,
  detector_version   TEXT NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN ('external', 'agent')),
  tier               TEXT NOT NULL CHECK (tier IN ('member', 'agent', 'external')),
  reason_families    TEXT[] NOT NULL,
  detector_error     BOOLEAN NOT NULL DEFAULT FALSE,
  payload            JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'dropped')),
  seen_count         INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ,
  decided_by         TEXT,
  released_target_id TEXT,
  CHECK ((status = 'held') = (decided_at IS NULL)),
  CHECK ((status = 'held') = (decided_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS write_gate_row_holds_dedupe_idx
  ON write_gate_row_holds (source_id, kind, slug, fingerprint, detector_version);

CREATE INDEX IF NOT EXISTS write_gate_row_holds_status_idx
  ON write_gate_row_holds (status, id);

-- A held row's receipt names the hold, with verdict `quarantine`.
ALTER TABLE write_gate_receipts DROP CONSTRAINT IF EXISTS write_gate_receipts_target_table_check;
ALTER TABLE write_gate_receipts ADD CONSTRAINT write_gate_receipts_target_table_check
  CHECK (target_table IN ('entity_facts', 'synth_takes', 'timeline_events', 'write_gate_row_holds'));
ALTER TABLE write_gate_receipts DROP CONSTRAINT IF EXISTS write_gate_receipts_verdict_check;
ALTER TABLE write_gate_receipts ADD CONSTRAINT write_gate_receipts_verdict_check
  CHECK (verdict IN ('flag', 'quarantine'));
