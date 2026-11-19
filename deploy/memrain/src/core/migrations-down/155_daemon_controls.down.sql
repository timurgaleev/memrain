SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE daemon_controls IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 155 THEN
    RAISE EXCEPTION '155 down: migration 155 is not the latest applied migration';
  END IF;
  -- Status columns (last run, failures, last window) are rebuilt by the next
  -- run; a pause or an override is an operator decision and is not.
  IF EXISTS (SELECT 1 FROM daemon_controls
              WHERE paused OR enabled IS NOT NULL OR cron IS NOT NULL OR timezone IS NOT NULL
                 OR cap_usd_per_day IS NOT NULL OR cap_usd_per_run IS NOT NULL) THEN
    RAISE EXCEPTION '155 down: operator daemon controls (pauses, overrides) must be retained';
  END IF;
END
$down$;

DROP TABLE daemon_controls;
DELETE FROM migrations WHERE id = 155;
