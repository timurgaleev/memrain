SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'control 006 down: migration 6 is not the latest applied migration';
  END IF;
END
$down$;

-- tenant_self as 005 defined it.
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
DELETE FROM migrations WHERE id = 6;
