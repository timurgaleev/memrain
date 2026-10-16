-- 141_admin_passkeys.sql — passkey sign-in for the admin panel.
--
-- The panel has one owner. These tables hold that owner's WebAuthn
-- credentials, the one-time recovery codes, the setup links an operator hands
-- out, and an append-only log of sign-in events.
--
-- Binary values (credential ids, COSE public keys, the user handle) are kept
-- as base64url TEXT: PGLite and postgres.js return BYTEA as different types.
-- Secrets (recovery codes, setup tokens) are stored only as SHA-256 hex, and a
-- reservation stores the hash of the pre-auth id that holds it, never the id.

-- The owner's WebAuthn user handle (random, no PII). Its row is also the lock
-- that serializes every owner-scoped mutation (SELECT … FOR UPDATE).
CREATE TABLE IF NOT EXISTS admin_owner (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  user_handle TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_passkeys (
  id            TEXT PRIMARY KEY,
  public_key    TEXT NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',
  device_type   TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  aaguid        TEXT,
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_via   TEXT NOT NULL CHECK (created_via IN ('setup_link', 'recovery', 'session')),
  -- The owner's first passkey from a setup link: no earlier owner to protect,
  -- so it starts without the enrollment cooldown.
  initial       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  code_hash       TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_for    TEXT,
  reserved_until  TIMESTAMPTZ,
  used_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS admin_recovery_codes_unused_idx
  ON admin_recovery_codes (batch_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_setup_links (
  id              TEXT PRIMARY KEY,
  nonce_hash      TEXT NOT NULL UNIQUE,
  created_via     TEXT NOT NULL CHECK (created_via IN ('cli', 'api', 'panel')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  reserved_for    TEXT,
  reserved_until  TIMESTAMPTZ,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_auth_events (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event       TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'fail')),
  reason      TEXT,
  via         TEXT CHECK (via IS NULL OR via IN ('cli', 'api', 'panel', 'setup_link', 'recovery', 'session')),
  credential  TEXT,
  client_key  TEXT,
  user_agent  TEXT,
  notice      BOOLEAN NOT NULL DEFAULT false,
  noticed_at  TIMESTAMPTZ,
  noticed_by  TEXT
);
CREATE INDEX IF NOT EXISTS admin_auth_events_at_idx ON admin_auth_events (at DESC);
CREATE INDEX IF NOT EXISTS admin_auth_events_notice_idx
  ON admin_auth_events (at) WHERE notice AND noticed_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_auth_events_fail_idx
  ON admin_auth_events (id) WHERE outcome = 'fail';
