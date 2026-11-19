SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 160 THEN
    RAISE EXCEPTION '160 down: migration 160 is not the latest applied migration';
  END IF;
END
$down$;

-- Every row is derived from state kept elsewhere (connector notices, daemon
-- controls, spend pauses, write-gate holds); the next reconcile after an up
-- rebuilds the open ones. Only undelivered webhooks are lost.
DROP TABLE IF EXISTS notifications;
DELETE FROM migrations WHERE id = 160;
