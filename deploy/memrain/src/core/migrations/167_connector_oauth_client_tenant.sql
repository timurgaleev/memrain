-- 167_connector_oauth_client_tenant.sql — the tenant of a bring-your-own
-- OAuth client.
--
-- A Microsoft Entra app decides who may sign in, and its authorize and token
-- endpoints carry that choice in their path: `common`, `organizations`,
-- `consumers`, a directory id or a verified domain. The tenant belongs to the
-- app registration, so it is stored with the client. NULL means the
-- provider's default. Lower case only, and no `/`, `?` or `#`, so a stored
-- value can never change the endpoint's path or host.
ALTER TABLE connector_oauth_clients ADD COLUMN IF NOT EXISTS tenant TEXT NULL
  CHECK (tenant IS NULL OR (
    length(tenant) <= 253
    AND tenant ~ '^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)$'
  ));
