SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE connector_cursors, connector_items, connector_notices IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 153 THEN
    RAISE EXCEPTION '153 down: migration 153 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM connector_cursors) OR EXISTS (SELECT 1 FROM connector_items)
     OR EXISTS (SELECT 1 FROM connector_notices) THEN
    RAISE EXCEPTION '153 down: connector sync state must be retained (cursors, items or notices exist)';
  END IF;
END
$down$;

DROP TABLE connector_notices;
DROP TABLE connector_items;
DROP TABLE connector_cursors;
DELETE FROM migrations WHERE id = 153;
