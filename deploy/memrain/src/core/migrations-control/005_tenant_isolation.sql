-- Control plane 005: the isolation smoke stamp.
--
-- A tenant container serves nothing but /health until the isolation smoke has
-- passed for it: after the container started, on the same host boot and the
-- same image. Only the operator's `memrain tenant smoke-record` writes the
-- stamp (master role); a tenant reads its own through tenant_self() and has no
-- way to write it.

CREATE TABLE IF NOT EXISTS tenant_isolation (
  tenant_id             TEXT PRIMARY KEY,
  container_started_at  TIMESTAMPTZ NOT NULL,
  boot_id               TEXT NOT NULL,
  image_stamp           TEXT NOT NULL,
  passed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
           'llm_off', coalesce((SELECT s.llm_off FROM public.hosting_settings s), true)
                      OR coalesce((SELECT w.llm_off FROM public.hosting_spend_windows w
                                    WHERE w.day = (now() AT TIME ZONE 'UTC')::date), false),
           'isolation', (SELECT jsonb_build_object(
                                  'boot_id', i.boot_id,
                                  'image_stamp', i.image_stamp,
                                  'passed_at', i.passed_at)
                           FROM public.tenant_isolation i WHERE i.tenant_id = t.id))
    FROM public.tenants t
   WHERE t.ctl_role = session_user
$fn$;
