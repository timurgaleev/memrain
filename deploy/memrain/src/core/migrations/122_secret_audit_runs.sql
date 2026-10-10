-- 122_secret_audit_runs.sql — the record of every stored-secret audit.
--
-- Write guards keep credentials out of new text, but rows stored before a
-- scanner rule existed keep what they carried. `memrain secrets audit` scans
-- the stored text again with the current rules; each run leaves one row here
-- so the `secret-exposure` doctor check can say when the brain was last
-- scanned, under which rule version, and whether hits are still unapplied.
-- A row carries counts by kind only: never a value, a preview or a slug.
--
--   secret_audit_runs.scan_version        SECRET_SCAN_VERSION the run used
--   secret_audit_runs.kinds               the stores scanned (pages, chunks, …)
--   secret_audit_runs.applied             true when the run rewrote what it found
--   secret_audit_runs.rows_affected       rows with at least one hit
--   secret_audit_runs.by_kind             {store: hits}
--   secret_audit_runs.by_secret_kind      {secret kind: hits}
--   secret_audit_runs.code_chunks_affected  chunks of code documents with a hit
--   secret_audit_runs.rows_rewritten      rows an applied run rewrote
--   secret_audit_runs.errors_total        rows an applied run could not rewrite
--   page_versions.scrubbed_at             set when an audit rewrote a version's
--                                         snapshot in place; its hash_new then
--                                         no longer matches the body
--
-- Additive, catalog-only on Postgres.

CREATE TABLE IF NOT EXISTS secret_audit_runs (
  id                   BIGSERIAL PRIMARY KEY,
  scan_version         INTEGER     NOT NULL,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  source_id            TEXT,
  kinds                TEXT[]      NOT NULL DEFAULT '{}',
  applied              BOOLEAN     NOT NULL DEFAULT false,
  rows_scanned         INTEGER     NOT NULL DEFAULT 0,
  rows_affected        INTEGER     NOT NULL DEFAULT 0,
  hits_total           INTEGER     NOT NULL DEFAULT 0,
  by_kind              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  by_secret_kind       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  code_chunks_affected INTEGER     NOT NULL DEFAULT 0,
  rows_rewritten       INTEGER     NOT NULL DEFAULT 0,
  errors_total         INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_secret_audit_runs_finished
  ON secret_audit_runs (finished_at DESC);

ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS scrubbed_at TIMESTAMPTZ;
