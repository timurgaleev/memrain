-- 124_retire_dead_scopes.down.sql — undo migration 124 (bookkeeping only).
--
--   bun run src/cli.ts apply-migrations --down 124 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 124_retire_dead_scopes.down.sql
--
-- A deliberate no-op on data: 124 removed `sources_admin` / `users_admin` from
-- stored grants, and no record of which rows held them was kept. Putting them
-- back would be guesswork, and unnecessary — neither name ever gated anything,
-- so an older release serves every client and token the same without them.
-- Only 124's migrations row is removed. It refuses, and changes nothing,
-- unless 124 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 124 THEN
    RAISE EXCEPTION '124 down: migration 124 is not the latest applied migration';
  END IF;
END
$down$;

DELETE FROM migrations WHERE id = 124;
