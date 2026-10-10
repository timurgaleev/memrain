-- 137_code_edges_from_symbol_idx.sql — index the calling symbol of a code edge.
--
-- code_flow (code-walk calleesHop) and structural expansion look edges up by
-- from_symbol_qualified, which had no index, so every hop scanned the whole
-- edge table. The table already has indexes on from_chunk_id and
-- to_symbol_qualified (migration 041).
--
-- Plain CREATE INDEX, no CONCURRENTLY: migrations apply in one transaction per
-- file, and the runner's lock_timeout bounds the wait on a busy table.

CREATE INDEX IF NOT EXISTS code_edges_symbol_from_sym_idx
  ON code_edges_symbol (from_symbol_qualified);
