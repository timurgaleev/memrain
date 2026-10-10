-- 136_wanted_links.down.sql — undo migration 136.
--
--   bun run src/cli.ts apply-migrations --down 136 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 136_wanted_links.down.sql
--
-- Drops wanted_links and 136's migrations row. Edges already reconnected stay;
-- references still waiting for their page are forgotten, as an older release
-- never recorded them. It refuses, and changes nothing, unless 136 is the
-- latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 136 THEN
    RAISE EXCEPTION '136 down: migration 136 is not the latest applied migration';
  END IF;
END
$down$;

DROP TABLE IF EXISTS wanted_links;

DELETE FROM migrations WHERE id = 136;
