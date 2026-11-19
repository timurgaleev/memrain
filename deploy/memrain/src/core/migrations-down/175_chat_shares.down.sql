SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 175 THEN
    RAISE EXCEPTION '175 down: migration 175 is not the latest applied migration';
  END IF;
END
$down$;

-- Every share link stops working with the table.
DROP TABLE IF EXISTS chat_shares;
DELETE FROM migrations WHERE id = 175;
