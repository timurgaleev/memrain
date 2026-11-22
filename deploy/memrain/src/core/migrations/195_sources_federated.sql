-- 195_sources_federated.sql — which sources an unscoped read reaches.
--
-- A read that names no source, from a caller whose grant names none (the
-- operator, the CLI, an unscoped key), reads the default source plus the
-- federated sources (core/sources.ts federatedReadScope). A source that is not
-- federated is reached only by an explicit grant, an explicit source_ids, or
-- the code tools.
--
-- Every existing source stays federated except the code sources, so note,
-- mail and calendar sources read as before and code chunks stop crowding notes
-- out of ordinary search. repo-source-code is named as well as kind 'code'
-- because migration 071 created it by id. A new code source registers
-- unfederated (registerSource); other kinds keep the column default.
--
-- The column and its first values are written together, once: on a re-run the
-- column exists and nothing is touched, so a later federate or unfederate
-- stands.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'federated'
  ) THEN
    ALTER TABLE sources ADD COLUMN federated BOOLEAN NOT NULL DEFAULT true;
    UPDATE sources SET federated = false WHERE kind = 'code' OR id = 'repo-source-code';
  END IF;
END
$$;
