-- 143_dedup_md5_long_rows.down.sql — undo migration 143.
--
--   bun run src/cli.ts apply-migrations --down 143 --yes
--   psql "$URL" -v ON_ERROR_STOP=1 -1 -f 143_dedup_md5_long_rows.down.sql
--
-- Restores the raw-text dedup indexes of 079 and 132 and drops 143's
-- migrations row. The old indexes are built under temporary names before the
-- md5 ones are dropped, then renamed: a row longer than a btree entry allows
-- makes the build fail, and an index already holding an old name makes the
-- rename fail, so the whole down rolls back with nothing changed. It also
-- refuses unless 143 is the latest migration.

SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 143 THEN
    RAISE EXCEPTION '143 down: migration 143 is not the latest applied migration';
  END IF;
END
$down$;

CREATE UNIQUE INDEX timeline_events_manual_dedup_idx_143down
  ON timeline_events (slug, occurred_at, event, source_label, source_id)
  WHERE source_chunk_id IS NULL;

CREATE UNIQUE INDEX entity_facts_dedup_speaker_idx_143down
  ON entity_facts (entity_slug, fact, source_chunk_id, (COALESCE(attributed_to, '')))
  WHERE source_chunk_id IS NOT NULL;

DROP INDEX timeline_events_manual_dedup_md5_idx;
DROP INDEX entity_facts_dedup_speaker_md5_idx;

ALTER INDEX timeline_events_manual_dedup_idx_143down RENAME TO timeline_events_manual_dedup_idx;
ALTER INDEX entity_facts_dedup_speaker_idx_143down RENAME TO entity_facts_dedup_speaker_idx;

DELETE FROM migrations WHERE id = 143;
