SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'control 003 down: migration 3 is not the latest applied migration';
  END IF;
  -- Each member is a live tenant container's login; dropping the group would
  -- cut them all off at once.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
     WHERE g.rolname = 'memrain_tenant_ctl'
  ) THEN
    RAISE EXCEPTION 'control 003 down: memrain_tenant_ctl still has members; purge the tenants first';
  END IF;
END
$down$;

DROP FUNCTION IF EXISTS public.tenant_self();
DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memrain_tenant_ctl') THEN
    REVOKE USAGE ON SCHEMA public FROM memrain_tenant_ctl;
    DROP ROLE memrain_tenant_ctl;
  END IF;
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END
$down$;
GRANT USAGE ON SCHEMA public TO PUBLIC;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
DELETE FROM migrations WHERE id = 3;
