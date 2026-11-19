-- 158_trust_tier.sql — how far a page, document or fact can be trusted.
--
-- One vocabulary, most trusted first (core/trust-tier.ts):
--
--   owner     the operator, the local CLI, the brain's own internal writers
--   member    a member principal ('member:<id>')
--   agent     any other authenticated client ('client:<id>', 'public')
--   external  text from an outside source kind, or written by a connector
--
-- The tier is recorded at write time from the credential the dispatcher stored
-- in written_by_principal and the kind of the source the row lands in. The
-- triggers below apply it on every write path; a value a caller supplies is
-- clamped to the writer's tier, and a write never raises a tier already
-- recorded (an owner edit does not certify an agent's or a connector's text).
--
-- No backfill. An existing row's tier depends on joins over sources and page
-- history, so computing it here would rewrite every row under a lock. NULL
-- means "not recorded"; readers derive the tier from the same evidence the
-- outside-content framing uses, and keep that derivation as a floor for
-- recorded rows too, so a stored tier only ever lowers the effective one.
--
-- documents.trust_tier has no trigger: documents carry no principal, so the
-- indexer records it when an authenticated client indexes inline text.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));

CREATE OR REPLACE FUNCTION memrain_trust_rank(tier TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE tier WHEN 'owner' THEN 3 WHEN 'member' THEN 2 WHEN 'agent' THEN 1 WHEN 'external' THEN 0 END
$fn$;

-- The less trusted of two tiers; NULL means "not recorded" and yields the other.
CREATE OR REPLACE FUNCTION memrain_min_trust_tier(a TEXT, b TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    WHEN memrain_trust_rank(a) <= memrain_trust_rank(b) THEN a
    ELSE b
  END
$fn$;

CREATE OR REPLACE FUNCTION memrain_write_trust_tier(principal TEXT, target_source TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM sources s WHERE s.id = target_source
                 AND s.kind IN ('github', 'mailbox', 'calendar', 'webhook', 'chat', 'meeting')) THEN 'external'
    WHEN principal IS NULL OR principal IN ('', 'operator') THEN 'owner'
    WHEN principal LIKE 'member:%' THEN 'member'
    ELSE 'agent'
  END
$fn$;

-- Every page write appends a version row carrying its principal, so the page's
-- tier follows its least trusted contributor.
CREATE OR REPLACE FUNCTION memrain_page_version_trust()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
DECLARE
  writer TEXT := CASE WHEN NEW.written_by = 'connector-github' THEN 'external'
                      ELSE memrain_write_trust_tier(NEW.written_by_principal, NEW.source_id) END;
BEGIN
  UPDATE pages
     SET trust_tier = memrain_min_trust_tier(COALESCE(trust_tier, 'owner'), writer)
   WHERE slug = NEW.slug
     AND trust_tier IS DISTINCT FROM memrain_min_trust_tier(COALESCE(trust_tier, 'owner'), writer);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS page_versions_trust_tier ON page_versions;
CREATE TRIGGER page_versions_trust_tier
  AFTER INSERT ON page_versions
  FOR EACH ROW
  EXECUTE FUNCTION memrain_page_version_trust();

CREATE OR REPLACE FUNCTION memrain_fact_trust()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.trust_tier := memrain_min_trust_tier(COALESCE(NEW.trust_tier, 'owner'),
    memrain_write_trust_tier(NEW.written_by_principal, NEW.source_id));
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS entity_facts_trust_tier ON entity_facts;
CREATE TRIGGER entity_facts_trust_tier
  BEFORE INSERT ON entity_facts
  FOR EACH ROW
  EXECUTE FUNCTION memrain_fact_trust();
