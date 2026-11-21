-- 187_embedding_input_hash.sql — what a stored vector was embedded from.
--
-- input_hash digests the embedding model, width, contextual tier and the exact
-- embedding input (core/embedding-input-hash.ts). A re-index reuses a stored
-- vector only when the hash of the chunk's current input matches, so a title
-- or synopsis change re-embeds the chunks whose wrapped input it changed.
-- NULL, the value every existing row keeps, means "provenance unknown": the
-- indexer then falls back to its old rule (same text, model and width), so
-- applying this migration re-embeds nothing. No backfill.
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS input_hash TEXT;
