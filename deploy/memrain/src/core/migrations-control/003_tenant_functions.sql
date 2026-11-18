-- Control plane 003: the one door a tenant container has into the control
-- database.
--
-- A tenant connects as its own login role `tenant_<id>_ctl`, a member of the
-- group `memrain_tenant_ctl`. That group holds EXECUTE on the control
-- functions and nothing else: no table privilege, no other function. Every
-- function is SECURITY DEFINER with a pinned search_path and finds the tenant
-- by `session_user`; none takes a tenant id, so no caller can name another
-- tenant.
--
-- Functions are executable by PUBLIC by default, and every database grants
-- CONNECT and TEMP to PUBLIC, so both are revoked first.

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Cluster-wide, so another control database on the same server may have made it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memrain_tenant_ctl') THEN
    CREATE ROLE memrain_tenant_ctl NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO memrain_tenant_ctl;

-- What this tenant may do now. A tenant still being provisioned is held
-- blocked; one being deleted is reported as deleting.
CREATE OR REPLACE FUNCTION public.tenant_self() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT jsonb_build_object(
           'id', t.id,
           'status', CASE t.status
                       WHEN 'active' THEN 'active'
                       WHEN 'suspended' THEN 'suspended'
                       WHEN 'provisioning' THEN 'suspended'
                       ELSE 'deleting' END,
           'mode', CASE t.status
                     WHEN 'suspended' THEN t.mode
                     WHEN 'provisioning' THEN 'block' END,
           'limits', t.plan_limits,
           'llm_off', false)
    FROM public.tenants t
   WHERE t.ctl_role = session_user
$fn$;

REVOKE ALL ON FUNCTION public.tenant_self() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_self() TO memrain_tenant_ctl;
