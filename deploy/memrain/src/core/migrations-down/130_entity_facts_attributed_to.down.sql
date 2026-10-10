-- 130_entity_facts_attributed_to.down.sql — undo migration 130.
--
--   bun run src/cli.ts apply-migrations --down 130 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 130_entity_facts_attributed_to.down.sql
--
-- Drops the attributed_to column and 130's migrations row. Rows keep their
-- text; only the speaker is lost, which is what an older release never had.
-- Two rows that differ only in speaker become restatements of one claim to the
-- older release's identity, and its next write refreshes the first of them.
-- It refuses, and changes nothing, unless 130 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 130 THEN
    RAISE EXCEPTION '130 down: migration 130 is not the latest applied migration';
  END IF;
END
$down$;

ALTER TABLE entity_facts DROP CONSTRAINT IF EXISTS entity_facts_attributed_to_check;
ALTER TABLE entity_facts DROP COLUMN attributed_to;

DELETE FROM migrations WHERE id = 130;
