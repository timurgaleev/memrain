-- 190_entity_dedupe_rejections.down.sql — undo migration 190.
--
--   bun run src/cli.ts apply-migrations --down 190 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 190_entity_dedupe_rejections.down.sql
--
-- Drops the rejected pairs: `memrain dedupe --preview` lists those pairs again.
-- It refuses, and changes nothing, unless 190 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 190 THEN
    RAISE EXCEPTION '190 down: migration 190 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS entity_dedupe_rejections;
DELETE FROM migrations WHERE id = 190;
