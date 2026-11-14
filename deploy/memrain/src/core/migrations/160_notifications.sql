-- 160_notifications.sql — what the owner is told needs attention.
--
-- A notification points at a problem that lives elsewhere: a connector that
-- needs a reconnect, deletions or items held, a spend path paused after an
-- overrun, a daemon auto-paused, write-gate holds waiting for review. It
-- names the problem by `kind` and `ref` (an account id, a daemon and source, a
-- spend path, a source id) and never copies its text: no title, body,
-- address or error message is stored here, so neither the admin list nor the
-- webhook can carry content.
--
-- One problem is one notification: at most one open row per (kind, ref). The
-- row is resolved when the problem goes away; a later episode opens a new row
-- (or reopens the last one shortly after it was resolved).
--
-- The webhook columns are an outbox: `pending` rows are delivered by the
-- notifications daemon with retries; `webhook_error` is a short code, never a
-- response body.
--
-- The row belongs to the source the problem is about and goes with it.
CREATE TABLE IF NOT EXISTS notifications (
  id                   BIGSERIAL PRIMARY KEY,
  source_id            TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'needs_reconnect', 'deletions_held', 'items_held',
                         'spend_path_paused', 'daemon_auto_paused', 'write_gate_hold')),
  ref                  TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 300),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reopened_at          TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  read_at              TIMESTAMPTZ,
  webhook_state        TEXT NOT NULL DEFAULT 'off'
                       CHECK (webhook_state IN ('off', 'pending', 'delivered', 'failed', 'cancelled')),
  webhook_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (webhook_attempts >= 0),
  webhook_next_at      TIMESTAMPTZ,
  webhook_lease_until  TIMESTAMPTZ,
  webhook_delivered_at TIMESTAMPTZ,
  webhook_error        TEXT CHECK (webhook_error IS NULL OR webhook_error ~ '^[a-z0-9_]{1,40}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_idx ON notifications (kind, ref)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_webhook_due_idx ON notifications (webhook_next_at)
  WHERE webhook_state = 'pending';
CREATE INDEX IF NOT EXISTS notifications_resolved_idx ON notifications (resolved_at)
  WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_source_idx ON notifications (source_id);
