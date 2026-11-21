-- 188_entity_dedupe_rejections.down.sql — undo migration 188.
--
--   bun run src/cli.ts apply-migrations --down 188 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 188_entity_dedupe_rejections.down.sql
--
-- Drops the rejected pairs: `memrain dedupe --preview` lists those pairs again.
-- It refuses, and changes nothing, unless 188 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 188 THEN
    RAISE EXCEPTION '188 down: migration 188 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS entity_dedupe_rejections;
DELETE FROM migrations WHERE id = 188;
