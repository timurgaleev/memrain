-- 143_dedup_md5_long_rows.sql — the manual timeline and chunk-fact dedup keys
-- hash the text.
--
-- Migrations 079 and 132 put the raw event / fact text into a unique btree
-- key. A btree entry holds at most 2704 bytes, so a longer event or fact could
-- not be stored at all: the insert failed on the index. The keys now carry
-- md5(text) in place of the text; the rest of each key (slug or entity, date,
-- source, chunk, speaker) is unchanged. Rows are not rewritten.

CREATE UNIQUE INDEX IF NOT EXISTS timeline_events_manual_dedup_md5_idx
  ON timeline_events (slug, occurred_at, md5(event), source_label, source_id)
  WHERE source_chunk_id IS NULL;

DROP INDEX IF EXISTS timeline_events_manual_dedup_idx;

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dedup_speaker_md5_idx
  ON entity_facts (entity_slug, md5(fact), source_chunk_id, (COALESCE(attributed_to, '')))
  WHERE source_chunk_id IS NOT NULL;

DROP INDEX IF EXISTS entity_facts_dedup_speaker_idx;
