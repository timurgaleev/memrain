SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 170 THEN
    RAISE EXCEPTION '170 down: migration 170 is not the latest applied migration';
  END IF;
END
$down$;

-- Chat history goes with the tables; nothing else points at them.
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_threads;
DELETE FROM migrations WHERE id = 170;
