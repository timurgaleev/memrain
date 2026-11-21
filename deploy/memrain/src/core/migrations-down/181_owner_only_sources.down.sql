SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 181 THEN
    RAISE EXCEPTION '181 down: migration 181 is not the latest applied migration';
  END IF;
END
$down$;

-- Derived rows keep their content; only the recorded origins and the flag go.
DROP TRIGGER IF EXISTS entity_facts_origins ON entity_facts;
DROP TRIGGER IF EXISTS timeline_events_origins ON timeline_events;
DROP TRIGGER IF EXISTS synth_takes_origins ON synth_takes;
DROP TRIGGER IF EXISTS synth_atoms_origins ON synth_atoms;
DROP TRIGGER IF EXISTS sources_retire_owner_only ON sources;
DROP FUNCTION IF EXISTS memrain_fact_origins();
DROP FUNCTION IF EXISTS memrain_timeline_origins();
DROP FUNCTION IF EXISTS memrain_take_origins();
DROP FUNCTION IF EXISTS memrain_atom_origins();
DROP FUNCTION IF EXISTS memrain_retire_owner_only_source();
DROP FUNCTION IF EXISTS memrain_record_origins(TEXT, TEXT, TEXT, TEXT[]);
DROP FUNCTION IF EXISTS memrain_owner_only_row(TEXT, TEXT);
DROP FUNCTION IF EXISTS memrain_owner_only_active();
DROP FUNCTION IF EXISTS memrain_brain_serves_several();
DROP FUNCTION IF EXISTS memrain_chunk_source(TEXT);
DROP FUNCTION IF EXISTS memrain_ref_source(TEXT);
DROP TABLE IF EXISTS owner_only_retired_sources;
DROP TABLE IF EXISTS derived_origins;
ALTER TABLE sources DROP COLUMN IF EXISTS owner_only;
ALTER TABLE secret_audit_runs DROP COLUMN IF EXISTS lane;
DELETE FROM migrations WHERE id = 181;
