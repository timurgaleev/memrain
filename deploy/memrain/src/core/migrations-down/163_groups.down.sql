SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 163 THEN
    RAISE EXCEPTION '163 down: migration 163 is not the latest applied migration';
  END IF;
  -- Dropping groups silently takes read access away from their members.
  IF EXISTS (SELECT 1 FROM groups) THEN
    RAISE EXCEPTION '163 down: groups exist; remove them first (memrain group remove <id>)';
  END IF;
END
$down$;

DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS group_sources;
DROP TABLE IF EXISTS groups;
DELETE FROM migrations WHERE id = 163;
