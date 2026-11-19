-- 159_write_gate_holds.sql — the owner's review queue for held writes.
--
-- When the write gate (core/write-gate.ts) holds a document whose text reads
-- as instructions to an AI, it stays out of search and a row lands here until
-- the operator approves or rejects it. A row is keyed by the document and the
-- hash of the title and body the gate assessed, so re-indexing the same
-- content never queues it twice and an edit queues the new content afresh.
--
-- Only a short neutralized excerpt is kept, never the full text; the row goes
-- with its document and with its source.
CREATE TABLE IF NOT EXISTS write_gate_holds (
  id               BIGSERIAL PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_ref       TEXT NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('external', 'agent')),
  reason_families  TEXT[] NOT NULL,
  detector_version TEXT NOT NULL,
  binding          TEXT NOT NULL,
  excerpt          TEXT NOT NULL DEFAULT '' CHECK (length(excerpt) <= 200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision         TEXT CHECK (decision IN ('approved', 'rejected', 'superseded')),
  decided_at       TIMESTAMPTZ,
  decided_by       TEXT,
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK ((decision IS NULL) = (decided_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS write_gate_holds_document_binding_idx
  ON write_gate_holds (document_id, binding);

CREATE INDEX IF NOT EXISTS write_gate_holds_open_idx
  ON write_gate_holds (created_at) WHERE decision IS NULL;
