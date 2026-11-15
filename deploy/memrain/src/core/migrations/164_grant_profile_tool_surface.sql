-- 164_grant_profile_tool_surface.sql — which ready-made profile a credential
-- was issued from, and which tool menu it gets.
--
-- profile / profile_catalog_version record the catalog entry
-- (core/grant-profiles.ts) the credential's scopes were expanded from, for
-- audit; they grant nothing themselves.
--
-- tool_surface narrows the tools a credential may list and call: 'full' (the
-- default, every tool its scopes allow), 'starter' or 'verbs'. A narrower
-- surface is a subset of the grant, never a superset (mcp/surface.ts).

ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS profile TEXT NULL;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS profile_catalog_version INT NULL;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS tool_surface TEXT NOT NULL DEFAULT 'full';
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS profile TEXT NULL;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS profile_catalog_version INT NULL;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS tool_surface TEXT NOT NULL DEFAULT 'full';

DO $$
BEGIN
  ALTER TABLE access_tokens ADD CONSTRAINT access_tokens_tool_surface_chk
    CHECK (tool_surface IN ('full', 'starter', 'verbs'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_tool_surface_chk
    CHECK (tool_surface IN ('full', 'starter', 'verbs'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
