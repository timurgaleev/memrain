-- Control plane 002: export receipts. A delete is accepted only on a receipt
-- taken under the tenant's current fence (tenants.fence_id).

CREATE TABLE IF NOT EXISTS tenant_exports (
  id          UUID PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  -- 'live': a copy for the customer, taken while the brain still runs;
  -- 'fenced': taken after the database was closed to every writer.
  kind        TEXT NOT NULL CHECK (kind IN ('live', 'fenced')),
  fence_id    UUID,
  out_dir     TEXT NOT NULL,
  tables      JSONB NOT NULL DEFAULT '[]'::jsonb,
  pages       INTEGER NOT NULL DEFAULT 0,
  ok          BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_exports_fenced_has_fence CHECK ((kind = 'fenced') = (fence_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS tenant_exports_tenant ON tenant_exports (tenant_id, created_at);
