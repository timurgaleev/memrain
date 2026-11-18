-- Control plane 004: the hosting-wide spend cap.
--
-- Every paid model call of every tenant reserves its worst case here before it
-- is sent (hosting_reserve) and settles it afterwards (hosting_settle). A
-- reservation counts against two UTC-day windows at once, the whole hosting
-- install's and its tenant's, and is taken only when both still have room.
--
-- Guarantees:
--   * spent + reserved <= cap at the moment of every new reservation;
--   * a reservation is never freed by time: past its TTL it becomes spent at
--     its full amount (hosting_expire), so a call still running when the TTL
--     ran out is counted, never forgotten;
--   * the actual cost is recorded as reported, even above the reservation; the
--     first such overrun turns paid calls off for every tenant for the rest of
--     the day (the window's llm_off) and records an event.
--
-- Lock order everywhere: reservation rows, then the hosting window, then the
-- tenant window.

CREATE TABLE IF NOT EXISTS hosting_settings (
  singleton        BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  cap_usd          NUMERIC NOT NULL DEFAULT 10 CHECK (cap_usd >= 0),
  -- The operator's switch: no paid call for any tenant while set.
  llm_off          BOOLEAN NOT NULL DEFAULT false,
  -- Floor of a reservation's lifetime: twice the longest model request
  -- timeout plus five minutes.
  min_ttl_seconds  INTEGER NOT NULL DEFAULT 540 CHECK (min_ttl_seconds > 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO hosting_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS hosting_spend_windows (
  day           DATE PRIMARY KEY,
  cap_usd       NUMERIC NOT NULL CHECK (cap_usd >= 0),
  reserved_usd  NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd     NUMERIC NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  -- Set by the first overrun of the day.
  llm_off       BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS tenant_spend_windows (
  tenant_id     TEXT NOT NULL,
  day           DATE NOT NULL,
  reserved_usd  NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd     NUMERIC NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE IF NOT EXISTS hosting_spend_reservations (
  id          UUID PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  day         DATE NOT NULL,
  usd         NUMERIC NOT NULL CHECK (usd >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  settled_at  TIMESTAMPTZ,
  outcome     TEXT CHECK (outcome IN ('settled', 'released', 'expired')),
  actual_usd  NUMERIC,
  CONSTRAINT hosting_spend_reservations_outcome CHECK ((settled_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX IF NOT EXISTS hosting_spend_reservations_open
  ON hosting_spend_reservations (expires_at) WHERE settled_at IS NULL;

-- Turn every reservation past its TTL into spend at its full amount.
CREATE OR REPLACE FUNCTION public.hosting_expire() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  n integer := 0;
  agg jsonb;
  g record;
BEGIN
  WITH gone AS (
    UPDATE public.hosting_spend_reservations
       SET settled_at = now(), outcome = 'expired', actual_usd = usd
     WHERE settled_at IS NULL AND expires_at <= now()
     RETURNING tenant_id, day, usd
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

-- Reserve `p_usd` for one call of the calling tenant, or say why not.
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
  PERFORM public.hosting_expire();
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

-- Settle one of the calling tenant's open reservations at what the call cost;
-- 0 releases it. An actual above the reservation is booked in full and turns
-- paid calls off for everyone for the rest of the day.
CREATE OR REPLACE FUNCTION public.hosting_settle(p_id uuid, p_actual numeric) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  tid text;
  r public.hosting_spend_reservations%ROWTYPE;
  today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_actual IS NULL OR p_actual < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  END IF;
  SELECT id INTO tid FROM public.tenants WHERE ctl_role = session_user;
  IF tid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_tenant');
  END IF;
  UPDATE public.hosting_spend_reservations
     SET settled_at = now(),
         outcome = CASE WHEN p_actual = 0 THEN 'released' ELSE 'settled' END,
         actual_usd = p_actual
   WHERE id = p_id AND tenant_id = tid AND settled_at IS NULL
  RETURNING * INTO r;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open');
  END IF;
  UPDATE public.hosting_spend_windows
     SET reserved_usd = greatest(reserved_usd - r.usd, 0), spent_usd = spent_usd + p_actual
   WHERE day = r.day;
  UPDATE public.tenant_spend_windows
     SET reserved_usd = greatest(reserved_usd - r.usd, 0), spent_usd = spent_usd + p_actual
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

REVOKE ALL ON FUNCTION public.hosting_expire() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosting_reserve(numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosting_settle(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hosting_reserve(numeric, integer) TO memrain_tenant_ctl;
GRANT EXECUTE ON FUNCTION public.hosting_settle(uuid, numeric) TO memrain_tenant_ctl;
