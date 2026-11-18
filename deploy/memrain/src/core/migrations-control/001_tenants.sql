-- Control plane 001: the hosted tenants and their lifecycle history.
--
-- One row per tenant brain. A tenant is never deleted from this table: a
-- purged tenant stays as `deleted`, so its id is never reused. The events log
-- has no foreign key on purpose — it outlives anything it talks about.

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  status              TEXT NOT NULL DEFAULT 'provisioning'
                      CHECK (status IN ('provisioning', 'active', 'suspended', 'deleting', 'deleted')),
  -- How a suspended tenant is held; set exactly while suspended.
  mode                TEXT CHECK (mode IN ('read-only', 'block')),
  db_name             TEXT NOT NULL UNIQUE,
  owner_role          TEXT NOT NULL UNIQUE,
  ctl_role            TEXT NOT NULL UNIQUE,
  hostname            TEXT NOT NULL UNIQUE,
  plan                TEXT NOT NULL DEFAULT 'personal' CHECK (plan IN ('personal', 'team')),
  plan_limits         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(plan_limits) = 'object'),
  owner_member        TEXT,
  connector_client_id TEXT,
  -- Changes whenever the tenant database is fenced or unfenced; an export
  -- receipt is only good for the fence it was taken under.
  fence_id            UUID,
  delete_after        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenants_mode_iff_suspended CHECK ((status = 'suspended') = (mode IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tenant_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_events_tenant_at ON tenant_events (tenant_id, at);
