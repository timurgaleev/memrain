-- 132_entity_facts_dedup_speaker.sql — the chunk dedup key includes the speaker.
--
-- Migration 018 made (entity_slug, fact, source_chunk_id) unique for
-- chunk-sourced facts. Migration 130 made the speaker part of a claim's
-- identity, but the index still collapsed an assistant's claim onto the
-- user's identical claim from the same chunk, and the re-emit path that
-- corrects valid_from on a conflict could date the other speaker's row.
--
-- The key now carries the speaker. A NULL speaker (every row before 130) is
-- its own value, so legacy chunk rows keep their idempotency among themselves.
-- The old index is stricter than the new one, so existing rows satisfy it.

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dedup_speaker_idx
  ON entity_facts (entity_slug, fact, source_chunk_id, (COALESCE(attributed_to, '')))
  WHERE source_chunk_id IS NOT NULL;

DROP INDEX IF EXISTS entity_facts_dedup_idx;
