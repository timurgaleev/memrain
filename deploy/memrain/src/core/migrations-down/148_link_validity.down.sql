SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE links IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 148 THEN
    RAISE EXCEPTION '148 down: migration 148 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM links WHERE valid_from IS NOT NULL OR valid_until IS NOT NULL) THEN
    RAISE EXCEPTION '148 down: populated link validity metadata must be retained';
  END IF;
END
$down$;

ALTER TABLE links DROP CONSTRAINT links_validity_interval;
ALTER TABLE links DROP COLUMN valid_until;
ALTER TABLE links DROP COLUMN valid_from;
DELETE FROM migrations WHERE id = 148;
