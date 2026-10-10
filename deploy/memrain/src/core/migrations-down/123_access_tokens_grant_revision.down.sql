-- 123_access_tokens_grant_revision.down.sql — undo migration 123.
--
--   bun run src/cli.ts apply-migrations --down 123 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 123_access_tokens_grant_revision.down.sql
--
-- Drops access_tokens.grant_revision and 123's migrations row. The `pat:<id>`
-- rows in oauth_grant_audit are history and stay; a later re-apply of 123
-- resumes each token's revision from them. It refuses, and changes nothing,
-- unless 123 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 123 THEN
    RAISE EXCEPTION '123 down: migration 123 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE access_tokens DROP COLUMN IF EXISTS grant_revision;

DELETE FROM migrations WHERE id = 123;
