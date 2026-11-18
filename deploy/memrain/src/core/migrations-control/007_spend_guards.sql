-- Control plane 007: the spend cap no longer trusts what a tenant reports.
--
-- Assume a tenant holds its own control login (a compromised container). Its
-- reservations and settlements are then whatever it wants them to be, so:
--   * a settlement books at most overrun_factor x its reservation; anything
--     reported above that is recorded as a `hosting_settle_anomaly` event;
--   * an overrun switches off paid calls for that tenant only, for the rest
--     of the UTC day (tenant_spend_windows.llm_off, read by tenant_self), and
--     records a `hosting_overrun` event. The install-wide switch stays the
--     operator's, and goes on by itself only when the install's real total
--     passes its cap;
--   * a reservation is never of nothing, never lives longer than
--     max_ttl_seconds, and a tenant holds at most max_open_reservations open;
--   * every tenant has a daily cap: plan_limits.maxUsdPerDay, else the
--     operator's default_tenant_day_usd;
--   * hosting_reserve sweeps the tenant's own expired reservations first,
--     whatever its status, and the sweep prunes settled rows older than
--     reservation_retention_days.

ALTER TABLE hosting_settings
  ADD COLUMN IF NOT EXISTS max_ttl_seconds INTEGER NOT NULL DEFAULT 900,
  ADD COLUMN IF NOT EXISTS max_open_reservations INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS default_tenant_day_usd NUMERIC NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS overrun_factor NUMERIC NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS reservation_retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE hosting_settings
  ADD CONSTRAINT hosting_settings_ttl_bounds CHECK (max_ttl_seconds >= min_ttl_seconds),
  ADD CONSTRAINT hosting_settings_open_positive CHECK (max_open_reservations > 0),
  ADD CONSTRAINT hosting_settings_default_cap CHECK (default_tenant_day_usd >= 0),
  ADD CONSTRAINT hosting_settings_overrun_factor CHECK (overrun_factor >= 1),
  ADD CONSTRAINT hosting_settings_retention CHECK (reservation_retention_days > 0);

ALTER TABLE tenant_spend_windows
  ADD COLUMN IF NOT EXISTS llm_off BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS hosting_spend_reservations_open_by_tenant
  ON hosting_spend_reservations (tenant_id) WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS hosting_spend_reservations_settled
  ON hosting_spend_reservations (settled_at) WHERE settled_at IS NOT NULL;

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
  -- Settled rows only matter to the windows they were booked into.
  DELETE FROM public.hosting_spend_reservations
   WHERE settled_at IS NOT NULL
     AND settled_at < now() - make_interval(days => (SELECT reservation_retention_days FROM public.hosting_settings))
     AND (p_tenant IS NULL OR tenant_id = p_tenant);
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
  open_n integer;
  rid uuid := gen_random_uuid();
BEGIN
  IF p_usd IS NULL OR p_usd <= 0 OR p_usd > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  END IF;
  SELECT * INTO t FROM public.tenants WHERE ctl_role = session_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_tenant');
  END IF;
  -- First, whatever the tenant's status: only its own expired rows; another
  -- tenant's still count as reserved until they are swept, which only errs
  -- toward refusing.
  PERFORM public.hosting_expire(t.id);
  IF t.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_inactive');
  END IF;
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
  IF tw.llm_off THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_llm_off');
  END IF;
  -- Counted under the tenant window's row lock, so parallel calls of one
  -- tenant cannot all see room.
  SELECT count(*) INTO open_n FROM public.hosting_spend_reservations
   WHERE tenant_id = t.id AND settled_at IS NULL;
  IF open_n >= s.max_open_reservations THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_open');
  END IF;
  IF w.spent_usd + w.reserved_usd + p_usd > w.cap_usd THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hosting_cap');
  END IF;
  tenant_cap := coalesce(CASE WHEN jsonb_typeof(t.plan_limits -> 'maxUsdPerDay') = 'number'
                              THEN (t.plan_limits ->> 'maxUsdPerDay')::numeric END,
                         s.default_tenant_day_usd);
  IF tw.spent_usd + tw.reserved_usd + p_usd > tenant_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_cap');
  END IF;
  UPDATE public.hosting_spend_windows SET reserved_usd = reserved_usd + p_usd WHERE day = d;
  UPDATE public.tenant_spend_windows SET reserved_usd = reserved_usd + p_usd WHERE tenant_id = t.id AND day = d;
  INSERT INTO public.hosting_spend_reservations (id, tenant_id, day, usd, expires_at)
  VALUES (rid, t.id, d, p_usd,
          now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 0), s.min_ttl_seconds), s.max_ttl_seconds)));
  RETURN jsonb_build_object('ok', true, 'id', rid);
END
$fn$;

-- Settle one of the calling tenant's reservations at what the call cost, as
-- the tenant reports it but never more than overrun_factor x the hold:
--   open, within its TTL   books the actual; 0 releases it
--   open, past its TTL     books the larger of the hold and the actual: time
--                          never frees a reservation
--   already expired        books only the part above the hold, once
-- Settling twice changes nothing the second time.
CREATE OR REPLACE FUNCTION public.hosting_settle(p_id uuid, p_actual numeric) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  tid text;
  r public.hosting_spend_reservations%ROWTYPE;
  s public.hosting_settings%ROWTYPE;
  today date := (now() AT TIME ZONE 'UTC')::date;
  actual numeric;
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
  SELECT * INTO s FROM public.hosting_settings;
  actual := least(p_actual, r.usd * s.overrun_factor);
  IF r.settled_at IS NULL THEN
    released := r.usd;
    IF r.expires_at <= now() THEN
      booked := greatest(r.usd, actual);
      UPDATE public.hosting_spend_reservations
         SET settled_at = now(), outcome = 'expired', actual_usd = booked WHERE id = r.id;
    ELSE
      booked := actual;
      UPDATE public.hosting_spend_reservations
         SET settled_at = now(), outcome = CASE WHEN actual = 0 THEN 'released' ELSE 'settled' END,
             actual_usd = actual
       WHERE id = r.id;
    END IF;
  ELSIF r.outcome = 'expired' AND actual > r.usd AND r.actual_usd <= r.usd THEN
    -- The sweep booked the hold; the call reports more. Book the rest, once.
    released := 0;
    booked := actual - r.usd;
    UPDATE public.hosting_spend_reservations SET actual_usd = actual WHERE id = r.id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open');
  END IF;
  UPDATE public.hosting_spend_windows
     SET reserved_usd = greatest(reserved_usd - released, 0), spent_usd = spent_usd + booked
   WHERE day = r.day;
  UPDATE public.tenant_spend_windows
     SET reserved_usd = greatest(reserved_usd - released, 0), spent_usd = spent_usd + booked
   WHERE tenant_id = tid AND day = r.day;
  -- Only the install's real total can switch everyone off.
  UPDATE public.hosting_spend_windows SET llm_off = true
   WHERE day = r.day AND NOT llm_off AND spent_usd + reserved_usd > cap_usd;
  IF p_actual > actual THEN
    INSERT INTO public.tenant_events (tenant_id, kind, detail)
    VALUES (tid, 'hosting_settle_anomaly',
            jsonb_build_object('reservation', r.id, 'reserved_usd', r.usd, 'reported_usd', p_actual, 'booked_usd', actual));
  END IF;
  IF actual > r.usd THEN
    INSERT INTO public.tenant_spend_windows (tenant_id, day) VALUES (tid, today) ON CONFLICT DO NOTHING;
    UPDATE public.tenant_spend_windows SET llm_off = true WHERE tenant_id = tid AND day = today;
    INSERT INTO public.tenant_events (tenant_id, kind, detail)
    VALUES (tid, 'hosting_overrun',
            jsonb_build_object('reservation', r.id, 'reserved_usd', r.usd, 'actual_usd', actual));
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
                                    WHERE w.day = (now() AT TIME ZONE 'UTC')::date), false)
                      OR coalesce((SELECT tw.llm_off FROM public.tenant_spend_windows tw
                                    WHERE tw.tenant_id = t.id
                                      AND tw.day = (now() AT TIME ZONE 'UTC')::date), false),
           'isolation', (SELECT jsonb_build_object(
                                  'boot_id', i.boot_id,
                                  'image_stamp', i.image_stamp,
                                  'passed_at', i.passed_at)
                           FROM public.tenant_isolation i WHERE i.tenant_id = t.id))
    FROM public.tenants t
   WHERE t.ctl_role = session_user
$fn$;
