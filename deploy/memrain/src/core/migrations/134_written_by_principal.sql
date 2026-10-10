-- 134_written_by_principal.sql — who actually wrote a row.
--
-- `written_by` is whatever the caller names: a skill slug, a recipe, any
-- string. It records intent, and any tenant can claim another's label.
-- written_by_principal records the credential the write arrived on, as the
-- MCP dispatcher resolved it:
--
--   operator                     the trusted local path / internal token
--   public                       the static public bearer
--   client:<id>                  an OAuth or PAT client
--   client:<id>|enrollment:<id>  one enrollment of a shared connector
--
-- NULL means the row was written before this migration, or by the brain's own
-- internal writers (importers, the cycle), which carry no credential. It is
-- audit data: shown to the operator and admin scope only, and never part of a
-- fact's claim identity. No backfill — an old row's principal is unknown.

ALTER TABLE page_versions
  ADD COLUMN IF NOT EXISTS written_by_principal TEXT;

ALTER TABLE entity_facts
  ADD COLUMN IF NOT EXISTS written_by_principal TEXT;

ALTER TABLE timeline_events
  ADD COLUMN IF NOT EXISTS written_by_principal TEXT;
