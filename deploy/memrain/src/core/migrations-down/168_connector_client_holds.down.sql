SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE notifications IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 168 THEN
    RAISE EXCEPTION '168 down: migration 168 is not the latest applied migration';
  END IF;
END
$down$;

-- Notifications are derived from state kept elsewhere: the ones about a
-- refused app go with the table they point at. A refused app is found again
-- by the next renewal it fails after an up.
DELETE FROM notifications WHERE kind = 'oauth_client_rejected';
ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
      'needs_reconnect',
      'deletions_held',
      'items_held',
      'spend_path_paused',
      'daemon_auto_paused',
      'write_gate_hold'
    ));
DROP TABLE IF EXISTS connector_client_holds;
DELETE FROM migrations WHERE id = 168;
