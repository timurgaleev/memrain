SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 178 THEN
    RAISE EXCEPTION '178 down: migration 178 is not the latest applied migration';
  END IF;
END
$down$;

-- Purged page text can be written back once the tombstones are gone.
DROP TABLE IF EXISTS page_purges;
DELETE FROM migrations WHERE id = 178;
