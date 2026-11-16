-- 163_groups.sql — groups of members and the sources each group reads.
--
-- Adding a member to a group lets that member's credentials read the group's
-- sources on their next request; removing the member takes it away again.
-- The union is computed by the token verifier (core/members.ts) into the
-- existing read set, so no read query changes.
--
-- A group only widens a credential that is already scoped to sources. It
-- never narrows an unscoped credential and never grants a write.

CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A deleted source severs the grant instead of leaving an id a future source
-- with the same name would inherit.
CREATE TABLE IF NOT EXISTS group_sources (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, source_id)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members (member_id);
