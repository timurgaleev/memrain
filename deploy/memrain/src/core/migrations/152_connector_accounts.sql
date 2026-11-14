-- 152_connector_accounts.sql — connector accounts and the encrypted token vault.
--
-- connector_accounts says which provider account feeds which source and who
-- connected it. Secrets never live there: tokens sit in connector_credentials
-- and bring-your-own OAuth client secrets in connector_oauth_clients, both as
-- AES-256-GCM envelopes (base64 TEXT, since PGLite and postgres.js return
-- BYTEA as different types). The key-encryption key never reaches the
-- database; kek_id only names which key sealed a row.
--
-- A source with an account cannot be deleted (RESTRICT): the account is
-- disconnected first. Deleting an account cascades to its credential only,
-- never to pages.
CREATE TABLE IF NOT EXISTS connector_accounts (
  id                  UUID PRIMARY KEY,
  source_id           TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  provider            TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  services            TEXT[] NOT NULL DEFAULT '{}',
  principal_ref       TEXT NOT NULL,
  account_label       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'needs_reconnect', 'revoked', 'error')),
  status_reason       TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  spend_cap_usd_daily NUMERIC(10, 4) NOT NULL DEFAULT 1.00 CHECK (spend_cap_usd_daily >= 0),
  item_cap_daily      INTEGER NOT NULL DEFAULT 5000 CHECK (item_cap_daily >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at     TIMESTAMPTZ,
  UNIQUE (source_id, provider, account_label)
);

CREATE INDEX IF NOT EXISTS connector_accounts_source_idx ON connector_accounts (source_id);

CREATE TABLE IF NOT EXISTS connector_credentials (
  account_id UUID PRIMARY KEY REFERENCES connector_accounts(id) ON DELETE CASCADE,
  kek_id     TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  scopes     TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connector_oauth_clients (
  provider   TEXT PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  client_id  TEXT NOT NULL,
  kek_id     TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
