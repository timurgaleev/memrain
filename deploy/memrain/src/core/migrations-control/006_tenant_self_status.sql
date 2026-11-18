-- Control plane 006: tenant_self() states the tenant's own lifecycle status.
--
-- Until now it folded `provisioning` into suspended/block and everything past
-- `suspended` into `deleting`. A container now sees the status as it is and
-- admits traffic only for `active`, with the one exception of a `suspended`
-- tenant held `read-only`; every other status, known or not, serves nothing
-- but /health. `mode` is the stored mode, set only while suspended.

CREATE OR REPLACE FUNCTION public.tenant_self() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT jsonb_build_object(
           'id', t.id,
           'status', t.status,
           'mode', CASE WHEN t.status = 'suspended' THEN t.mode END,
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
