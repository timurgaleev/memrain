-- 154_connector_oauth_states.sql — one-time state for a connector OAuth connect.
--
-- Only the SHA-256 of the state and of the admin session id are kept, so a
-- database read cannot replay a callback. The PKCE verifier is sealed with the
-- connector key. consumed_at is set by a single conditional UPDATE, which is
-- what makes a state usable once. Rows expire after minutes and are pruned on
-- the next connect; a deleted source takes its pending states with it.
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  state_hash         TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  principal_ref      TEXT NOT NULL,
  admin_session_hash TEXT NOT NULL,
  kek_id             TEXT NOT NULL,
  nonce              TEXT NOT NULL,
  pkce_verifier_enc  TEXT NOT NULL,
  requested_scopes   TEXT[] NOT NULL,
  services           TEXT[] NOT NULL DEFAULT '{}',
  redirect_uri       TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS connector_oauth_states_expires_idx ON connector_oauth_states (expires_at);
