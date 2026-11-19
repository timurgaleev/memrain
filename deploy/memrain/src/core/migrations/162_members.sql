-- 162_members.sql — the people of a team brain.
--
-- A member is a named person. Personal access tokens, OAuth clients and
-- enrollment grants may name the member they belong to; the verifier refuses
-- every credential of a member that is disabled or removed, in one place
-- (core/members.ts), so turning one person off stops all of their keys while
-- everyone else keeps working.
--
-- A brain with no members behaves exactly as before: a credential with no
-- member_id is verified the way it always was.
--
-- Ids are never reused. Removing a member leaves a tombstone (status
-- 'removed', email cleared) so audit history and credentials that name the id
-- can never be handed to a different person.

CREATE TABLE IF NOT EXISTS members (
  id                 TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name       TEXT NULL,
  -- Optional and personal: cleared on removal, never written to an audit row
  -- or the request log.
  email              TEXT NULL,
  status             TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled', 'removed')),
  -- The member's own source, recorded for offboarding. It grants nothing on
  -- its own: what a credential reads comes from the credential and the
  -- member's groups.
  personal_source_id TEXT NULL REFERENCES sources(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at         TIMESTAMPTZ NULL,
  CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CHECK (status <> 'removed' OR email IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS members_email_live_idx
  ON members (lower(email)) WHERE email IS NOT NULL AND status <> 'removed';

ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS member_id TEXT NULL REFERENCES members(id);
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS member_id TEXT NULL REFERENCES members(id);
ALTER TABLE oauth_enrollments ADD COLUMN IF NOT EXISTS member_id TEXT NULL REFERENCES members(id);

CREATE INDEX IF NOT EXISTS idx_access_tokens_member ON access_tokens (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_member ON oauth_clients (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_enrollments_member ON oauth_enrollments (member_id) WHERE member_id IS NOT NULL;

-- Who added, disabled, enabled, removed or bound a member, and every group
-- change. No foreign keys on purpose: the history outlives the rows it
-- describes, like oauth_enrollment_audit.
CREATE TABLE IF NOT EXISTS member_audit (
  id         BIGSERIAL PRIMARY KEY,
  member_id  TEXT NULL,
  group_id   TEXT NULL,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  via        TEXT NOT NULL CHECK (via IN ('cli', 'admin_api')),
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (member_id IS NOT NULL OR group_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_member_audit_member ON member_audit (member_id, created_at DESC) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_member_audit_group ON member_audit (group_id, created_at DESC) WHERE group_id IS NOT NULL;
