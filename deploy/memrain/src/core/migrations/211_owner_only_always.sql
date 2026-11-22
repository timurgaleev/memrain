-- 211_owner_only_always.sql — an owner-only source is closed whether the brain
-- serves one person or several.
--
-- Migration 181 applied owner-only lineage only once the brain served several
-- people, so on a one-person brain an unbound remote key still read the
-- owner's mailbox and what was derived from it. Marking a source owner-only
-- now closes it, and every row derived from it, to every remote caller but the
-- owner's credential at once (core/owner-only.ts).
CREATE OR REPLACE FUNCTION memrain_owner_only_active() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM sources WHERE owner_only) OR EXISTS (SELECT 1 FROM owner_only_retired_sources)
$$;
