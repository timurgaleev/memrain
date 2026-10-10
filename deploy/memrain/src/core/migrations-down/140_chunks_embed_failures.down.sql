-- 140_chunks_embed_failures.down.sql — undo migration 140.
--
--   bun run src/cli.ts apply-migrations --down 140 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 140_chunks_embed_failures.down.sql
--
-- Drops chunks.embed_failures and 140's migrations row. The chunks stay; the
-- embed-gaps phase of an older release retries every chunk again.
-- It refuses, and changes nothing, unless 140 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 140 THEN
    RAISE EXCEPTION '140 down: migration 140 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE chunks DROP COLUMN IF EXISTS embed_failures;

DELETE FROM migrations WHERE id = 140;
