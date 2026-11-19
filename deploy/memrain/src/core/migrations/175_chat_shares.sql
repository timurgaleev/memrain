-- 175_chat_shares.sql — password links to one chat answer (MEMRAIN_CHAT_SHARE,
-- off by default).
--
-- Only hashes are stored: the link token's SHA-256 and the password's
-- argon2id hash. A link lives 7 days; `revoked_at` ends it early. After five
-- wrong passwords in a row the link is locked for a while (`locked_until`).
-- A link goes with its answer: deleting the thread, retention and
-- `memrain erase chat` take it by cascade.
CREATE TABLE IF NOT EXISTS chat_shares (
  token_hash       TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  message_id       BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  owner_key        TEXT NOT NULL CHECK (length(owner_key) BETWEEN 1 AND 200),
  password_hash    TEXT NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_shares_message_idx ON chat_shares (message_id);
