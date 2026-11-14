SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE fact_purge_receipts IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION '150 down: migration 150 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM fact_purge_receipts) THEN
    RAISE EXCEPTION '150 down: fact purge receipts must be retained';
  END IF;
END
$down$;

DROP TABLE fact_purge_receipts;
DELETE FROM migrations WHERE id = 150;
