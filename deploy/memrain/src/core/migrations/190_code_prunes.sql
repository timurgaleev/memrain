-- 190_code_prunes.sql — provenance for code documents a code sweep retired
-- because their file is gone from the repository.
--
-- A code sweep (or `memrain code prune --apply`) soft-deletes the document of
-- a deleted source file (`documents.deleted_at`, the shared 72 h soft delete)
-- and records one row here per document: which pass did it, when, from which
-- root and why. `memrain code restore <doc-id> | --sweep <id>` flips the
-- document back while its `deleted_at` still equals `pruned_at`, so a document
-- something else deleted later is never resurrected. There is no foreign key
-- to documents on purpose: the row says what went after the purge removed it.
--
-- A document restored by the operator (`restored_by = 'cli'`) is held back from
-- the automatic pass until a sweep sees its file again (`hold_released_at`).
-- The purge keeps a pruned document past its TTL while its file is back, so the
-- next sweep can revive it.
CREATE TABLE IF NOT EXISTS code_prunes (
  id           BIGSERIAL PRIMARY KEY,
  sweep_id     TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('sweep', 'cli')),
  document_id  TEXT NOT NULL,
  source_id    TEXT REFERENCES sources(id) ON DELETE SET NULL ON UPDATE CASCADE,
  source_path  TEXT NOT NULL,
  root         TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT 'file_missing' CHECK (reason IN ('file_missing')),
  pruned_at    TIMESTAMPTZ NOT NULL,
  restored_at  TIMESTAMPTZ,
  restored_by  TEXT CHECK (restored_by IN ('cli', 'file_returned')),
  hold_released_at TIMESTAMPTZ,
  CHECK ((restored_at IS NULL) = (restored_by IS NULL))
);

CREATE INDEX IF NOT EXISTS code_prunes_sweep_idx ON code_prunes (sweep_id);
CREATE INDEX IF NOT EXISTS code_prunes_open_doc_idx ON code_prunes (document_id) WHERE restored_at IS NULL;
