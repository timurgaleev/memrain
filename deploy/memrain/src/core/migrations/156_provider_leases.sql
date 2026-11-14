-- 156_provider_leases.sql — slots that bound parallel calls to one provider.
--
-- A caller holds one row per in-flight call under `lease_key` (for example
-- 'bedrock:haiku'). Acquiring counts the unexpired rows for the key under a
-- transaction-scoped advisory lock and inserts only while the count is below
-- the configured limit; rows past `expires_at` belong to a holder that died
-- and are deleted by the next acquire.
CREATE TABLE IF NOT EXISTS provider_leases (
  id          TEXT PRIMARY KEY,
  lease_key   TEXT NOT NULL,
  owner       TEXT NOT NULL,
  owner_job   TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_leases_key_idx
  ON provider_leases (lease_key, expires_at);
