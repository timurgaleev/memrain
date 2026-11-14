SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 158 THEN
    RAISE EXCEPTION '158 down: migration 158 is not the latest applied migration';
  END IF;
  -- A page's or fact's recorded tier is rederived from its principal, source
  -- and page history once the column is gone. An inline-indexed document's
  -- is not: dropping it would stop framing an agent's text as outside content.
  IF EXISTS (SELECT 1 FROM documents WHERE trust_tier IS NOT NULL AND trust_tier <> 'owner') THEN
    RAISE EXCEPTION '158 down: documents indexed inline by agents carry a trust tier nothing else records; delete or re-index them as the operator first';
  END IF;
END
$down$;

-- Dropping the columns forgets the remaining recorded tiers; readers fall back
-- to deriving every row's tier from sources and page history, as before 158.
DROP TRIGGER IF EXISTS entity_facts_trust_tier ON entity_facts;
DROP TRIGGER IF EXISTS page_versions_trust_tier ON page_versions;
DROP FUNCTION IF EXISTS memrain_fact_trust();
DROP FUNCTION IF EXISTS memrain_page_version_trust();
DROP FUNCTION IF EXISTS memrain_write_trust_tier(TEXT, TEXT);
DROP FUNCTION IF EXISTS memrain_min_trust_tier(TEXT, TEXT);
DROP FUNCTION IF EXISTS memrain_trust_rank(TEXT);
ALTER TABLE documents DROP COLUMN IF EXISTS trust_tier;
ALTER TABLE entity_facts DROP COLUMN IF EXISTS trust_tier;
ALTER TABLE pages DROP COLUMN IF EXISTS trust_tier;
DELETE FROM migrations WHERE id = 158;
