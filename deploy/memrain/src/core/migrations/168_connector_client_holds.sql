-- 168_connector_client_holds.sql — an OAuth app its provider refused.
--
-- When a provider's token endpoint refuses the OAuth app itself
-- (`invalid_client`: a wrong or expired client secret, an app the provider
-- does not know; `unauthorized_client`: an app the tenant does not know, or
-- one that may not renew the token), no reconnect helps and every account of
-- the app fails alike. One row per provider records it: the provider's
-- accounts stop syncing until `held_until` (one try an hour for the
-- provider, not one per account and run), and the owner is told once
-- (notification kind `oauth_client_rejected`, ref = the provider). Saving or
-- removing the provider's app, or a renewal that succeeds, deletes the row.
--
-- `client_id` is the refused app's id (public; never the secret), `reason`
-- the provider's OAuth error code and `service_code` Microsoft's AADSTS
-- number when it sent one. No provider text is stored.
CREATE TABLE IF NOT EXISTS connector_client_holds (
  provider     TEXT PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  client_id    TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
  reason       TEXT NOT NULL CHECK (reason IN ('invalid_client', 'unauthorized_client')),
  service_code INTEGER CHECK (service_code IS NULL OR service_code >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refused_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  held_until   TIMESTAMPTZ NOT NULL
);

-- Same replace-the-CHECK pattern as migration 151.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
      'needs_reconnect',
      'deletions_held',
      'items_held',
      'spend_path_paused',
      'daemon_auto_paused',
      'write_gate_hold',
      'oauth_client_rejected'
    ));
