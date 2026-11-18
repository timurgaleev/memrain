SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'control 005 down: migration 5 is not the latest applied migration';
  END IF;
END
$down$;

-- tenant_self as 004 defined it.
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
                                    WHERE w.day = (now() AT TIME ZONE 'UTC')::date), false))
    FROM public.tenants t
   WHERE t.ctl_role = session_user
$fn$;
DROP TABLE IF EXISTS tenant_isolation;
DELETE FROM migrations WHERE id = 5;
