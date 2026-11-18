-- 172_member_web_auth.sql — member sign-in for /app.
--
-- An operator hands a member a one-time invite link. The member opens it,
-- registers a passkey (or, on a device without one, takes a single short
-- session), and signs in to /app from then on with the passkey. The session
-- lives in the memrain_app cookie; the cookie carries a random id, this table
-- its hash.
--
-- Secrets are stored only as SHA-256 hex: the invite token, the session id,
-- and the pre-auth browser id a reservation is held for. Binary WebAuthn
-- values are base64url TEXT, as in 141_admin_passkeys.sql.
--
-- Every row hangs off its member. Members are tombstoned rather than deleted,
-- so removal revokes these rows in code (core/member-sessions.ts); the
-- cascade covers a member row that is deleted outright.

CREATE TABLE IF NOT EXISTS member_passkeys (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- The WebAuthn user handle: random, one per member, no PII.
  user_handle   TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',
  device_type   TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS member_passkeys_member_idx ON member_passkeys (member_id);

CREATE TABLE IF NOT EXISTS member_invites (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  -- First time the invite page was opened: the start of the
  -- invite-to-first-answer clock.
  opened_at       TIMESTAMPTZ,
  reserved_for    TEXT,
  reserved_until  TIMESTAMPTZ,
  used_at         TIMESTAMPTZ,
  used_via        TEXT CHECK (used_via IS NULL OR used_via IN ('passkey', 'no_passkey')),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS member_invites_member_idx ON member_invites (member_id);

CREATE TABLE IF NOT EXISTS member_web_sessions (
  id_hash       TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  via           TEXT NOT NULL CHECK (via IN ('passkey', 'invite')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS member_web_sessions_member_idx ON member_web_sessions (member_id) WHERE revoked_at IS NULL;

-- A member binding its own connector code or key from /app is audited as
-- via 'app', next to the operator's 'cli' and 'admin_api'.
ALTER TABLE member_audit DROP CONSTRAINT IF EXISTS member_audit_via_check;
ALTER TABLE member_audit ADD CONSTRAINT member_audit_via_check CHECK (via IN ('cli', 'admin_api', 'app'));
