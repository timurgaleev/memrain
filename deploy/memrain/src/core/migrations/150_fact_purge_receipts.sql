-- 150_fact_purge_receipts.sql — what a page purge retired, per page.
--
-- A purge retires the facts written on each page it frees (forgotten_cause
-- 'purge'). The page row and its history are gone afterwards, so this receipt
-- is the only record of which fact ids went with which page: clearing
-- forgotten_at / forgotten_cause on exactly those ids undoes the retirement.
-- Written in the purge transaction itself, so a rolled-back purge leaves none.
CREATE TABLE IF NOT EXISTS fact_purge_receipts (
  id         BIGSERIAL PRIMARY KEY,
  purge_id   UUID NOT NULL,
  page_slug  TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  fact_ids   BIGINT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fact_purge_receipts_page_idx
  ON fact_purge_receipts (page_slug, created_at DESC);
