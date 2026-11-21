-- 184_derived_trust_tiers.sql — rows a model or a parser drew from other rows
-- inherit the least trusted tier among them.
--
-- Migration 158 records a tier on pages, facts and documents from the writer's
-- credential and the source kind. A row derived from other text was still
-- recorded at its writer's tier: an atom or a take the synthesis cycle (an
-- internal writer, so `owner`) drew from an agent's page, a timeline entry
-- projected from a connector's event page, a fact extracted from a meeting
-- chunk into a page of the default source. Those rows now take the lower of
-- their writer's tier and the tier of the page, document or chunk they name as
-- their origin, at insert time. A supplied tier is clamped the same way, so a
-- writer can lower a row's tier (a think take drawn from many pages), never
-- raise it.
--
-- New rows only: no existing row is rewritten (as in 158). A NULL tier still
-- means "not recorded" and readers derive it as before.

ALTER TABLE synth_atoms ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));
ALTER TABLE synth_takes ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));
ALTER TABLE timeline_events ADD COLUMN IF NOT EXISTS trust_tier TEXT
  CHECK (trust_tier IS NULL OR trust_tier IN ('owner', 'member', 'agent', 'external'));

CREATE OR REPLACE FUNCTION memrain_rank_trust_tier(r INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE r WHEN 3 THEN 'owner' WHEN 2 THEN 'member' WHEN 1 THEN 'agent' WHEN 0 THEN 'external' END
$fn$;

-- Effective rank of a page: its stored tier, its source kind, a GitHub
-- projection and every version's writer (core/trust-tier.ts pageRankSql).
-- The least trusted copy when the slug exists in several sources and none is
-- named. NULL when no such page exists.
CREATE OR REPLACE FUNCTION memrain_page_trust_rank(page_slug TEXT, page_source TEXT)
RETURNS INT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $fn$
  SELECT MIN(LEAST(
    COALESCE(memrain_trust_rank(p.trust_tier), 3),
    memrain_trust_rank(memrain_write_trust_tier(NULL, p.source_id)),
    CASE WHEN p.compiled_truth->>'provider' = 'github' THEN 0 ELSE 3 END,
    COALESCE((SELECT MIN(CASE WHEN v.written_by = 'connector-github' THEN 0
                              ELSE memrain_trust_rank(memrain_write_trust_tier(v.written_by_principal, NULL)) END)
                FROM page_versions v WHERE v.slug = p.slug AND v.source_id = p.source_id), 3)))
    FROM pages p
   WHERE p.slug = page_slug AND (page_source IS NULL OR p.source_id = page_source)
$fn$;

-- Effective rank of a document: its stored tier, its source kind and the page
-- it mirrors (core/trust-tier.ts documentRankSql). NULL when no such document.
CREATE OR REPLACE FUNCTION memrain_document_trust_rank(doc_id TEXT)
RETURNS INT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $fn$
  SELECT LEAST(
    COALESCE(memrain_trust_rank(d.trust_tier), 3),
    memrain_trust_rank(memrain_write_trust_tier(NULL, d.source_id)),
    COALESCE((SELECT MIN(memrain_page_trust_rank(p.slug, p.source_id)) FROM pages p
               WHERE p.source_id = COALESCE(d.source_id, 'default')
                 AND d.source_path IN (
                   CASE WHEN p.source_id = 'default' THEN 'page://' || p.slug ELSE 'page://' || p.source_id || '/' || p.slug END,
                   CASE WHEN p.source_id = 'default' THEN 'page-truth://' || p.slug ELSE 'page-truth://' || p.source_id || '/' || p.slug END,
                   p.slug, p.slug || '.md', p.slug || '.markdown')), 3))
    FROM documents d WHERE d.id = doc_id
$fn$;

-- The tier of the page slug or document id a derived row names as its origin;
-- NULL when the reference resolves to neither.
CREATE OR REPLACE FUNCTION memrain_ref_trust_tier(ref TEXT, ref_source TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN ref IS NULL OR ref = '' THEN NULL
    ELSE memrain_rank_trust_tier(COALESCE(memrain_page_trust_rank(ref, ref_source), memrain_document_trust_rank(ref))) END
$fn$;

-- The tier of the text a timeline or fact chunk key points at: a meeting or
-- body projection names its page (in whichever source holds it, as
-- memrain_chunk_source reads it; the least trusted copy), anything else may be
-- a chunk id.
CREATE OR REPLACE FUNCTION memrain_chunk_trust_tier(chunk_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN chunk_id IS NULL THEN NULL
    WHEN chunk_id LIKE 'meeting-timeline:%' THEN memrain_ref_trust_tier(substr(chunk_id, length('meeting-timeline:') + 1), NULL)
    WHEN chunk_id LIKE 'body-timeline:%' THEN memrain_ref_trust_tier(split_part(substr(chunk_id, length('body-timeline:') + 1), ':', 1), NULL)
    ELSE memrain_rank_trust_tier((SELECT memrain_document_trust_rank(c.document_id) FROM chunks c WHERE c.id = chunk_id LIMIT 1))
  END
$fn$;

CREATE OR REPLACE FUNCTION memrain_fact_trust()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.trust_tier := memrain_min_trust_tier(
    memrain_min_trust_tier(COALESCE(NEW.trust_tier, 'owner'), memrain_write_trust_tier(NEW.written_by_principal, NEW.source_id)),
    memrain_min_trust_tier(
      memrain_min_trust_tier(memrain_ref_trust_tier(NEW.source_slug, NEW.source_id),
                             memrain_ref_trust_tier(NEW.source_markdown_slug, NEW.source_id)),
      memrain_chunk_trust_tier(NEW.source_chunk_id)));
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION memrain_ref_row_trust()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.trust_tier := memrain_min_trust_tier(COALESCE(NEW.trust_tier, 'owner'), memrain_ref_trust_tier(NEW.source_ref, NULL));
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS synth_atoms_trust_tier ON synth_atoms;
CREATE TRIGGER synth_atoms_trust_tier
  BEFORE INSERT ON synth_atoms
  FOR EACH ROW
  EXECUTE FUNCTION memrain_ref_row_trust();

DROP TRIGGER IF EXISTS synth_takes_trust_tier ON synth_takes;
CREATE TRIGGER synth_takes_trust_tier
  BEFORE INSERT ON synth_takes
  FOR EACH ROW
  EXECUTE FUNCTION memrain_ref_row_trust();

-- A timeline entry: its writer, its source kind, the chunk it was parsed from
-- and the event page it projects. A projection refreshed from an edited event
-- page takes the page's tier again, never a higher one.
CREATE OR REPLACE FUNCTION memrain_timeline_trust()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.event IS NOT DISTINCT FROM OLD.event AND NEW.detail IS NOT DISTINCT FROM OLD.detail
     AND NEW.event_slug IS NOT DISTINCT FROM OLD.event_slug THEN
    RETURN NEW;
  END IF;
  NEW.trust_tier := memrain_min_trust_tier(
    memrain_min_trust_tier(COALESCE(NEW.trust_tier, 'owner'), memrain_write_trust_tier(NEW.written_by_principal, NEW.source_id)),
    memrain_min_trust_tier(memrain_chunk_trust_tier(NEW.source_chunk_id),
                           memrain_ref_trust_tier(NEW.event_slug, NEW.source_id)));
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS timeline_events_trust_tier ON timeline_events;
CREATE TRIGGER timeline_events_trust_tier
  BEFORE INSERT OR UPDATE ON timeline_events
  FOR EACH ROW
  EXECUTE FUNCTION memrain_timeline_trust();
