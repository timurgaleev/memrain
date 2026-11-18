SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'control 007 down: migration 7 is not the latest applied migration';
  END IF;
END
$down$;

-- The spend functions as 004 defined them, tenant_self as 006 did.
CREATE OR REPLACE FUNCTION public.hosting_expire(p_tenant text DEFAULT NULL) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  n integer := 0;
  agg jsonb;
  g record;
BEGIN
  WITH due AS (
    SELECT id FROM public.hosting_spend_reservations
     WHERE settled_at IS NULL AND expires_at <= now()
       AND (p_tenant IS NULL OR tenant_id = p_tenant)
     ORDER BY id
     FOR UPDATE SKIP LOCKED
  ), gone AS (
    UPDATE public.hosting_spend_reservations r
       SET settled_at = now(), outcome = 'expired', actual_usd = r.usd
      FROM due WHERE r.id = due.id
     RETURNING r.tenant_id, r.day, r.usd
  )
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO agg
    FROM (SELECT tenant_id, day, sum(usd) AS usd, count(*) AS c FROM gone GROUP BY tenant_id, day) x;
  FOR g IN
    SELECT * FROM jsonb_to_recordset(agg) AS r(tenant_id text, day date, usd numeric, c integer)
     ORDER BY day, tenant_id
  LOOP
    UPDATE public.hosting_spend_windows
       SET reserved_usd = greatest(reserved_usd - g.usd, 0), spent_usd = spent_usd + g.usd
     WHERE day = g.day;
    UPDATE public.tenant_spend_windows
       SET reserved_usd = greatest(reserved_usd - g.usd, 0), spent_usd = spent_usd + g.usd
     WHERE tenant_id = g.tenant_id AND day = g.day;
    n := n + g.c;
  END LOOP;
  RETURN n;
END
$fn$;

CREATE OR REPLACE FUNCTION public.hosting_reserve(p_usd numeric, p_ttl_seconds integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  t public.tenants%ROWTYPE;
  s public.hosting_settings%ROWTYPE;
  w public.hosting_spend_windows%ROWTYPE;
  tw public.tenant_spend_windows%ROWTYPE;
  d date := (now() AT TIME ZONE 'UTC')::date;
  tenant_cap numeric;
  rid uuid := gen_random_uuid();
BEGIN
  IF p_usd IS NULL OR p_usd < 0 OR p_usd > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  END IF;
  SELECT * INTO t FROM public.tenants WHERE ctl_role = session_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_tenant');
  END IF;
  IF t.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_inactive');
  END IF;
  -- Only this tenant's own expired rows; another tenant's still count as
  -- reserved until they are swept, which only errs toward refusing.
  PERFORM public.hosting_expire(t.id);
  SELECT * INTO s FROM public.hosting_settings;
  IF s.llm_off THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'llm_off');
  END IF;
  INSERT INTO public.hosting_spend_windows (day, cap_usd) VALUES (d, s.cap_usd) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.hosting_spend_windows WHERE day = d FOR UPDATE;
  IF w.llm_off THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'llm_off');
  END IF;
  INSERT INTO public.tenant_spend_windows (tenant_id, day) VALUES (t.id, d) ON CONFLICT DO NOTHING;
  SELECT * INTO tw FROM public.tenant_spend_windows WHERE tenant_id = t.id AND day = d FOR UPDATE;
  IF w.spent_usd + w.reserved_usd + p_usd > w.cap_usd THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hosting_cap');
  END IF;
  tenant_cap := CASE WHEN jsonb_typeof(t.plan_limits -> 'maxUsdPerDay') = 'number'
                     THEN (t.plan_limits ->> 'maxUsdPerDay')::numeric END;
  IF tenant_cap IS NOT NULL AND tw.spent_usd + tw.reserved_usd + p_usd > tenant_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_cap');
  END IF;
  UPDATE public.hosting_spend_windows SET reserved_usd = reserved_usd + p_usd WHERE day = d;
  UPDATE public.tenant_spend_windows SET reserved_usd = reserved_usd + p_usd WHERE tenant_id = t.id AND day = d;
  INSERT INTO public.hosting_spend_reservations (id, tenant_id, day, usd, expires_at)
  VALUES (rid, t.id, d, p_usd,
          now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 0), s.min_ttl_seconds)));
  RETURN jsonb_build_object('ok', true, 'id', rid);
END
$fn$;

CREATE OR REPLACE FUNCTION public.hosting_settle(p_id uuid, p_actual numeric) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  tid text;
  r public.hosting_spend_reservations%ROWTYPE;
  today date := (now() AT TIME ZONE 'UTC')::date;
  booked numeric;
  released numeric;
BEGIN
  IF p_actual IS NULL OR p_actual < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  END IF;
  SELECT id INTO tid FROM public.tenants WHERE ctl_role = session_user;
  IF tid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_tenant');
  END IF;
  SELECT * INTO r FROM public.hosting_spend_reservations WHERE id = p_id AND tenant_id = tid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open');
  END IF;
  IF r.settled_at IS NULL THEN
    released := r.usd;
    IF r.expires_at <= now() THEN
      booked := greatest(r.usd, p_actual);
      UPDATE public.hosting_spend_reservations
         SET settled_at = now(), outcome = 'expired', actual_usd = booked WHERE id = r.id;
    ELSE
      booked := p_actual;
      UPDATE public.hosting_spend_reservations
         SET settled_at = now(), outcome = CASE WHEN p_actual = 0 THEN 'released' ELSE 'settled' END,
             actual_usd = p_actual
       WHERE id = r.id;
    END IF;
  ELSIF r.outcome = 'expired' AND p_actual > r.usd AND r.actual_usd <= r.usd THEN
    -- The sweep booked the hold; the call reports more. Book the rest.
    released := 0;
    booked := p_actual - r.usd;
    UPDATE public.hosting_spend_reservations SET actual_usd = p_actual WHERE id = r.id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open');
  END IF;
  UPDATE public.hosting_spend_windows
     SET reserved_usd = greatest(reserved_usd - released, 0), spent_usd = spent_usd + booked
   WHERE day = r.day;
  UPDATE public.tenant_spend_windows
     SET reserved_usd = greatest(reserved_usd - released, 0), spent_usd = spent_usd + booked
   WHERE tenant_id = tid AND day = r.day;
  IF p_actual > r.usd THEN
    INSERT INTO public.hosting_spend_windows (day, cap_usd)
    SELECT today, cap_usd FROM public.hosting_settings ON CONFLICT DO NOTHING;
    UPDATE public.hosting_spend_windows SET llm_off = true WHERE day = today;
    INSERT INTO public.tenant_events (tenant_id, kind, detail)
    VALUES (tid, 'hosting_overrun',
            jsonb_build_object('reservation', r.id, 'reserved_usd', r.usd, 'actual_usd', p_actual));
    RETURN jsonb_build_object('ok', true, 'overrun', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'overrun', false);
END
$fn$;

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

DROP INDEX IF EXISTS hosting_spend_reservations_settled;
DROP INDEX IF EXISTS hosting_spend_reservations_open_by_tenant;
ALTER TABLE tenant_spend_windows DROP COLUMN IF EXISTS llm_off;
ALTER TABLE hosting_settings
  DROP CONSTRAINT IF EXISTS hosting_settings_retention,
  DROP CONSTRAINT IF EXISTS hosting_settings_overrun_factor,
  DROP CONSTRAINT IF EXISTS hosting_settings_default_cap,
  DROP CONSTRAINT IF EXISTS hosting_settings_open_positive,
  DROP CONSTRAINT IF EXISTS hosting_settings_ttl_bounds,
  DROP COLUMN IF EXISTS reservation_retention_days,
  DROP COLUMN IF EXISTS overrun_factor,
  DROP COLUMN IF EXISTS default_tenant_day_usd,
  DROP COLUMN IF EXISTS max_open_reservations,
  DROP COLUMN IF EXISTS max_ttl_seconds;
DELETE FROM migrations WHERE id = 7;
