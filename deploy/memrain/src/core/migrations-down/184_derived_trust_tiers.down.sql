SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 184 THEN
    RAISE EXCEPTION '184 down: migration 184 is not the latest applied migration';
  END IF;
END
$down$;

-- Facts keep the tiers already recorded (a stored tier only ever lowers the
-- effective one); new facts go back to the writer-and-source rule of 158.
DROP TRIGGER IF EXISTS timeline_events_trust_tier ON timeline_events;
DROP TRIGGER IF EXISTS synth_takes_trust_tier ON synth_takes;
DROP TRIGGER IF EXISTS synth_atoms_trust_tier ON synth_atoms;
DROP FUNCTION IF EXISTS memrain_timeline_trust();
DROP FUNCTION IF EXISTS memrain_ref_row_trust();

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

DROP FUNCTION IF EXISTS memrain_chunk_trust_tier(TEXT);
DROP FUNCTION IF EXISTS memrain_ref_trust_tier(TEXT, TEXT);
DROP FUNCTION IF EXISTS memrain_document_trust_rank(TEXT);
DROP FUNCTION IF EXISTS memrain_page_trust_rank(TEXT, TEXT);
DROP FUNCTION IF EXISTS memrain_rank_trust_tier(INT);
-- Timeline tiers are rederived at read time from the same evidence; atom and
-- take tiers have no reader of their own.
ALTER TABLE timeline_events DROP COLUMN IF EXISTS trust_tier;
ALTER TABLE synth_takes DROP COLUMN IF EXISTS trust_tier;
ALTER TABLE synth_atoms DROP COLUMN IF EXISTS trust_tier;
DELETE FROM migrations WHERE id = 184;
