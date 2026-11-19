-- 153_connector_cursors_items.sql — where each connector stream stopped, what
-- each provider item became, and what the owner has to look at.
--
-- connector_cursors: one row per (account, stream). A mail or chat account has
-- many streams (a history feed, a backfill, one per calendar or channel), so a
-- single watermark per account cannot say how far each got. The sync engine
-- moves a cursor only past items that are written, unchanged or held.
--
-- connector_items: one row per provider item. It maps the provider's id to the
-- page it became, counts consecutive failures on the same version, and carries
-- a hold: an item that kept failing (held_reason = error code) stops blocking
-- its stream's cursor, and a deletion past the mass-delete threshold waits for
-- the owner (held_reason = 'mass_delete') instead of running.
--
-- connector_notices: what the owner is told — a credential that needs a
-- reconnect, deletions held for confirmation, items held. At most one open
-- notice per account and kind, so a run repeating every 15 minutes does not
-- pile up copies.
--
-- account_id references connector_accounts (migration 152) when that table
-- exists; the foreign keys are added below only then, so these tables also
-- stand on a schema where 152 is not applied yet.
CREATE TABLE IF NOT EXISTS connector_cursors (
  account_id UUID NOT NULL,
  stream     TEXT NOT NULL CHECK (length(stream) BETWEEN 1 AND 300),
  cursor     TEXT NOT NULL,
  floor      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, stream)
);

CREATE TABLE IF NOT EXISTS connector_items (
  account_id          UUID NOT NULL,
  external_id         TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  external_version    TEXT,
  page_slug           TEXT,
  dedupe_key          TEXT,
  content_hash        TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_upstream_at TIMESTAMPTZ,
  fail_count          INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  last_error          TEXT,
  held_reason         TEXT,
  held_until          TIMESTAMPTZ,
  PRIMARY KEY (account_id, external_id)
);

CREATE INDEX IF NOT EXISTS connector_items_page_slug_idx ON connector_items (page_slug);
CREATE INDEX IF NOT EXISTS connector_items_dedupe_idx ON connector_items (account_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS connector_items_held_idx ON connector_items (account_id)
  WHERE held_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS connector_items_seen_idx ON connector_items (account_id, last_seen_at);

CREATE TABLE IF NOT EXISTS connector_notices (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('needs_reconnect', 'mass_delete_held', 'items_held')),
  detail      TEXT NOT NULL CHECK (length(detail) <= 1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_notices_open_idx ON connector_notices (account_id, kind)
  WHERE resolved_at IS NULL;

DO $fk$
BEGIN
  IF to_regclass('connector_accounts') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_cursors_account_fk') THEN
      ALTER TABLE connector_cursors ADD CONSTRAINT connector_cursors_account_fk
        FOREIGN KEY (account_id) REFERENCES connector_accounts (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_items_account_fk') THEN
      ALTER TABLE connector_items ADD CONSTRAINT connector_items_account_fk
        FOREIGN KEY (account_id) REFERENCES connector_accounts (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_notices_account_fk') THEN
      ALTER TABLE connector_notices ADD CONSTRAINT connector_notices_account_fk
        FOREIGN KEY (account_id) REFERENCES connector_accounts (id) ON DELETE CASCADE;
    END IF;
  END IF;
END
$fk$;
