-- 132_entity_facts_dedup_speaker.down.sql — undo migration 132.
--
--   bun run src/cli.ts apply-migrations --down 132 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 132_entity_facts_dedup_speaker.down.sql
--
-- Restores the speaker-blind (entity_slug, fact, source_chunk_id) unique index
-- and drops 132's migrations row. Two speakers' identical claims from one chunk
-- cannot share that index, so it refuses, and changes nothing, while any such
-- pair exists; it also refuses unless 132 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 132 THEN
    RAISE EXCEPTION '132 down: migration 132 is not the latest applied migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM entity_facts
     WHERE source_chunk_id IS NOT NULL
     GROUP BY entity_slug, fact, source_chunk_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '132 down: some chunk claims are held by more than one speaker; the old index cannot hold them';
  END IF;
END
$down$;

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dedup_idx
  ON entity_facts (entity_slug, fact, source_chunk_id)
  WHERE source_chunk_id IS NOT NULL;

DROP INDEX IF EXISTS entity_facts_dedup_speaker_idx;

DELETE FROM migrations WHERE id = 132;
