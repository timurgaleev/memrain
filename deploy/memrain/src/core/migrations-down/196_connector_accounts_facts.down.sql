-- 196_connector_accounts_facts.down.sql — undo migration 196.
--
--   bun run src/cli.ts apply-migrations --down 196 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 196_connector_accounts_facts.down.sql
--
-- Drops connector_accounts.facts_extraction and facts_cap_usd_daily and 196's
-- migrations row. Do not run it after any account was enabled: the opt-in and
-- its cap are lost, and a later forward run starts every account off again.
-- Rolling the code back never needs it (the columns are additive). It refuses,
-- and changes nothing, unless 196 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 196 THEN
    RAISE EXCEPTION '196 down: migration 196 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE connector_accounts DROP CONSTRAINT IF EXISTS connector_accounts_facts_cap_chk;
ALTER TABLE connector_accounts DROP COLUMN IF EXISTS facts_cap_usd_daily;
ALTER TABLE connector_accounts DROP COLUMN IF EXISTS facts_extraction;

DELETE FROM migrations WHERE id = 196;
