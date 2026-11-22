-- 211_owner_only_always.down.sql — undo migration 211.
--
--   bun run src/cli.ts apply-migrations --down 211 --yes
--
-- Owner-only lineage applies again only once the brain serves several people.
-- Code from the release that shipped 211 still narrows a remote caller's
-- source scope on a one-person brain; only the lineage test reopens.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 211 THEN
    RAISE EXCEPTION '211 down: migration 211 is not the latest applied migration';
  END IF;
END
$down$;

CREATE OR REPLACE FUNCTION memrain_owner_only_active() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT (EXISTS (SELECT 1 FROM sources WHERE owner_only) OR EXISTS (SELECT 1 FROM owner_only_retired_sources))
     AND memrain_brain_serves_several()
$$;
DELETE FROM migrations WHERE id = 211;
