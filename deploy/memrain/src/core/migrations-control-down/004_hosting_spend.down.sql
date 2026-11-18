SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'control 004 down: migration 4 is not the latest applied migration';
  END IF;
END
$down$;

DROP FUNCTION IF EXISTS public.hosting_settle(uuid, numeric);
DROP FUNCTION IF EXISTS public.hosting_reserve(numeric, integer);
DROP FUNCTION IF EXISTS public.hosting_expire(text);
DROP TABLE IF EXISTS hosting_spend_reservations;
DROP TABLE IF EXISTS tenant_spend_windows;
DROP TABLE IF EXISTS hosting_spend_windows;
DROP TABLE IF EXISTS hosting_settings;

-- tenant_self as 003 defined it.
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
DELETE FROM migrations WHERE id = 4;
