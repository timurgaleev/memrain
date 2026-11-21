-- 181_owner_only_sources.sql — owner-only sources and where derived rows came from.
--
-- A source marked owner_only (a personal mailbox or calendar) is read only by
-- the trusted local operator and by a credential bound to the brain owner,
-- once the brain serves several people. What was extracted from such a source
-- often lands elsewhere: a fact on a person page in a shared source, a take,
-- an attendee's timeline row, an atom and the concept page built from it. So
-- every derived row records the sources it came from (derived_origins), at
-- insert time by the triggers below and for older rows by
-- `memrain sources provenance`. Recording is metadata only: no derived row is
-- rewritten. A source that is deleted while owner-only is remembered in
-- owner_only_retired_sources, so its derived rows stay closed after it goes.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS owner_only BOOLEAN NOT NULL DEFAULT false;

-- Which audit lane a secret audit ran: NULL for a store audit, 'transcripts'
-- for the agent-transcript rescan. A rule change that reaches transcripts only
-- is complete once that lane ran under it (core/doctor-secrets.ts).
ALTER TABLE secret_audit_runs ADD COLUMN IF NOT EXISTS lane TEXT;

CREATE TABLE IF NOT EXISTS derived_origins (
  row_kind         TEXT NOT NULL CHECK (row_kind IN ('fact', 'timeline', 'take', 'atom', 'page')),
  row_id           TEXT NOT NULL,
  origin_source_id TEXT NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (row_kind, row_id, origin_source_id)
);
CREATE INDEX IF NOT EXISTS idx_derived_origins_source ON derived_origins (origin_source_id);

CREATE TABLE IF NOT EXISTS owner_only_retired_sources (
  source_id  TEXT PRIMARY KEY,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The source a page slug or document id lives in, or NULL.
CREATE OR REPLACE FUNCTION memrain_ref_source(ref TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT p.source_id FROM pages p WHERE p.slug = ref LIMIT 1),
    (SELECT d.source_id FROM documents d WHERE d.id = ref LIMIT 1))
$$;

-- The source a timeline row's chunk key points at: a meeting or body
-- projection names its page, anything else may be a chunk id.
CREATE OR REPLACE FUNCTION memrain_chunk_source(chunk_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN chunk_id IS NULL THEN NULL
    WHEN chunk_id LIKE 'meeting-timeline:%' THEN memrain_ref_source(substr(chunk_id, length('meeting-timeline:') + 1))
    WHEN chunk_id LIKE 'body-timeline:%' THEN memrain_ref_source(split_part(substr(chunk_id, length('body-timeline:') + 1), ':', 1))
    ELSE (SELECT d.source_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = chunk_id LIMIT 1)
  END
$$;

-- The brain serves several people: two or more enabled members, or config
-- access.serves = several. Mirrors core/caller-access.ts servesPolicyFrom.
CREATE OR REPLACE FUNCTION memrain_brain_serves_several() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) >= 2 FROM members WHERE status = 'enabled')
      OR COALESCE(lower(btrim((SELECT value FROM config WHERE key = 'access.serves'))) = 'several', false)
$$;

-- Owner-only lineage applies: the brain serves several people and holds (or
-- held) an owner-only source. Read once per statement as an InitPlan.
CREATE OR REPLACE FUNCTION memrain_owner_only_active() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT (EXISTS (SELECT 1 FROM sources WHERE owner_only) OR EXISTS (SELECT 1 FROM owner_only_retired_sources))
     AND memrain_brain_serves_several()
$$;

-- A derived row came from an owner-only source (live or retired).
CREATE OR REPLACE FUNCTION memrain_owner_only_row(kind TEXT, id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM derived_origins o
     WHERE o.row_kind = kind AND o.row_id = id
       AND (EXISTS (SELECT 1 FROM sources s WHERE s.id = o.origin_source_id AND s.owner_only)
            OR EXISTS (SELECT 1 FROM owner_only_retired_sources r WHERE r.source_id = o.origin_source_id)))
$$;

CREATE OR REPLACE FUNCTION memrain_record_origins(kind TEXT, id TEXT, own_source TEXT, origins TEXT[]) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO derived_origins (row_kind, row_id, origin_source_id)
  SELECT DISTINCT kind, id, o FROM unnest(origins) AS o
   WHERE o IS NOT NULL AND o IS DISTINCT FROM own_source
  ON CONFLICT DO NOTHING
$$;

CREATE OR REPLACE FUNCTION memrain_fact_origins() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM memrain_record_origins('fact', NEW.id::text, NEW.source_id,
    ARRAY[memrain_ref_source(NEW.source_slug), memrain_ref_source(NEW.source_markdown_slug), memrain_chunk_source(NEW.source_chunk_id)]);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION memrain_timeline_origins() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM memrain_record_origins('timeline', NEW.id::text, NEW.source_id, ARRAY[memrain_chunk_source(NEW.source_chunk_id)]);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION memrain_take_origins() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM memrain_record_origins('take', NEW.id::text, NULL, ARRAY[memrain_ref_source(NEW.source_ref)]);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION memrain_atom_origins() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM memrain_record_origins('atom', NEW.id::text, NULL, ARRAY[memrain_ref_source(NEW.source_ref)]);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION memrain_retire_owner_only_source() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.owner_only THEN
    INSERT INTO owner_only_retired_sources (source_id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS entity_facts_origins ON entity_facts;
CREATE TRIGGER entity_facts_origins AFTER INSERT ON entity_facts FOR EACH ROW EXECUTE FUNCTION memrain_fact_origins();
DROP TRIGGER IF EXISTS timeline_events_origins ON timeline_events;
CREATE TRIGGER timeline_events_origins AFTER INSERT ON timeline_events FOR EACH ROW EXECUTE FUNCTION memrain_timeline_origins();
DROP TRIGGER IF EXISTS synth_takes_origins ON synth_takes;
CREATE TRIGGER synth_takes_origins AFTER INSERT ON synth_takes FOR EACH ROW EXECUTE FUNCTION memrain_take_origins();
DROP TRIGGER IF EXISTS synth_atoms_origins ON synth_atoms;
CREATE TRIGGER synth_atoms_origins AFTER INSERT ON synth_atoms FOR EACH ROW EXECUTE FUNCTION memrain_atom_origins();
DROP TRIGGER IF EXISTS sources_retire_owner_only ON sources;
CREATE TRIGGER sources_retire_owner_only BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION memrain_retire_owner_only_source();

