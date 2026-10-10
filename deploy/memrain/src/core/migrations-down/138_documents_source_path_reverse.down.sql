-- 138_documents_source_path_reverse.down.sql — undo migration 138.
--
--   bun run src/cli.ts apply-migrations --down 138 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 138_documents_source_path_reverse.down.sql
--
-- Drops the reversed source_path index and 138's migrations row. No data is
-- touched; code citations go back to scanning documents.
-- It refuses, and changes nothing, unless 138 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 138 THEN
    RAISE EXCEPTION '138 down: migration 138 is not the latest applied migration';
  END IF;
END
$down$;

DROP INDEX IF EXISTS documents_source_path_rev_idx;

DELETE FROM migrations WHERE id = 138;
