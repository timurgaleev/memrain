-- 137_code_edges_from_symbol_idx.down.sql — undo migration 137.
--
--   bun run src/cli.ts apply-migrations --down 137 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 137_code_edges_from_symbol_idx.down.sql
--
-- Drops the from_symbol_qualified index and 137's migrations row. No data is
-- touched; code_flow reads go back to scanning the edge table.
-- It refuses, and changes nothing, unless 137 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 137 THEN
    RAISE EXCEPTION '137 down: migration 137 is not the latest applied migration';
  END IF;
END
$down$;

DROP INDEX IF EXISTS code_edges_symbol_from_sym_idx;

DELETE FROM migrations WHERE id = 137;
