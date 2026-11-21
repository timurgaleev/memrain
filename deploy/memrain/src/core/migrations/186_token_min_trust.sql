-- 186_token_min_trust.sql — a per-credential read floor.
--
-- min_trust names the least trusted tier (core/trust-tier.ts: owner > member >
-- agent > external) a credential may read. NULL, the default, is no floor:
-- every existing credential reads exactly as before. A credential with a floor
-- reads only through tools that filter by tier (search, query, context_pack),
-- at the stricter of its floor and the call's own min_trust; every other tool
-- that returns stored text is refused to it. Only the local CLI sets it
-- (`memrain auth create --min-trust`, `memrain auth min-trust`).
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS min_trust TEXT
  CHECK (min_trust IS NULL OR min_trust IN ('owner', 'member', 'agent', 'external'));
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS min_trust TEXT
  CHECK (min_trust IS NULL OR min_trust IN ('owner', 'member', 'agent', 'external'));
