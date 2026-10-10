-- 140_chunks_embed_failures.sql — how often a chunk's embed call failed for a
-- reason that will not pass on its own.
--
-- The embed-gaps cycle phase walks vector-less chunks in id order. A chunk
-- whose embed keeps failing (an input the model refuses, say) sat at the front
-- of that order on every tick and used up the tick's budget, so the chunks
-- behind it were never reached. The backfill now counts such failures here and
-- the phase leaves a chunk out once it has failed often enough. A transient
-- failure (throttle, timeout, outage) is not counted.
--
-- A re-index deletes and re-inserts a document's chunks, so new text starts
-- from zero. A constant default makes the column add metadata-only.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embed_failures INTEGER NOT NULL DEFAULT 0;
