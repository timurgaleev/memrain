SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE provider_leases IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 156 THEN
    RAISE EXCEPTION '156 down: migration 156 is not the latest applied migration';
  END IF;
  -- A live row is a call in flight; dropping the table under it would fail
  -- that caller's release instead of letting it finish.
  IF EXISTS (SELECT 1 FROM provider_leases WHERE expires_at > NOW()) THEN
    RAISE EXCEPTION '156 down: live provider leases are held; wait for them to expire';
  END IF;
END
$down$;

DROP TABLE provider_leases;
DELETE FROM migrations WHERE id = 156;
