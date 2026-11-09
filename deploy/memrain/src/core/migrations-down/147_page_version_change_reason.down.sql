SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 147 THEN
    RAISE EXCEPTION '147 down: migration 147 is not the latest applied migration';
  END IF;
END
$down$;

LOCK TABLE page_versions IN ACCESS EXCLUSIVE MODE;
DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM page_versions WHERE change_reason IS NOT NULL) THEN
    RAISE EXCEPTION '147 down: populated change_reason metadata must be retained';
  END IF;
END
$down$;

ALTER TABLE page_versions DROP COLUMN change_reason;
DELETE FROM migrations WHERE id = 147;
