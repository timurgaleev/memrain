-- 180_secret_store.sql — the originals a redaction removed from a page.
--
-- When the write path replaces a credential with its marker
-- `[REDACTED:<kind>:<fingerprint>]`, the value it removed is sealed here under
-- the connector key (AES-256-GCM, bound to its source and fingerprint), so the
-- owner can read it back or put a false positive back. One entry per value
-- and source; each place the redactor put its marker is an occurrence. No
-- value is ever stored in clear, and the fingerprint is the one the marker
-- already shows on the page.
--
-- Purging a page removes its occurrences and every entry no other page still
-- holds. Values redacted before this table existed were not kept.
CREATE TABLE IF NOT EXISTS secret_store (
  id          BIGSERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  kind        TEXT NOT NULL,
  kek_id      TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  -- allowed: the owner restored it as a false positive; redaction leaves it alone in this source.
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'allowed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS secret_store_occurrences (
  id         BIGSERIAL PRIMARY KEY,
  entry_id   BIGINT NOT NULL REFERENCES secret_store(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('body', 'title', 'truth')),
  marker     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entry_id, slug, field, marker)
);

CREATE INDEX IF NOT EXISTS secret_store_occurrences_slug_idx ON secret_store_occurrences (slug);
