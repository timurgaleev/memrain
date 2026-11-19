-- 174_retrieval_feedback.sql — ratings of what a search found, and the soft
-- per-page weights learned from them (MEMRAIN_FEEDBACK, off by default).
--
-- A rating is +1 (useful), -1 (not useful) or 0 (withdrawn) on one page, by
-- one principal, kept under the page's own source. `explicit` comes from the
-- answer buttons in chat; `implicit` from a page read shortly after the search
-- that returned it. Only a hash of the principal is stored and never the
-- question. `content_hash` is the page's hash when it was rated, so a rating of
-- an older version counts for less. Raw rows are kept 180 days; the weight row
-- is the aggregate that outlives them.
--
-- Both tables name the page by a foreign key to pages(slug): purging the page
-- (or deleting its source) takes its ratings and its weight.
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  principal_hash  TEXT NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  tier            TEXT NOT NULL CHECK (tier IN ('owner', 'member', 'agent')),
  query_id        TEXT CHECK (query_id IS NULL OR length(query_id) <= 100),
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN -1 AND 1),
  signal          TEXT NOT NULL CHECK (signal IN ('explicit', 'implicit')),
  content_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retrieval_feedback_page_idx ON retrieval_feedback (source_id, slug, created_at);
CREATE INDEX IF NOT EXISTS retrieval_feedback_principal_idx ON retrieval_feedback (principal_hash, created_at);
CREATE INDEX IF NOT EXISTS retrieval_feedback_created_idx ON retrieval_feedback (created_at);
CREATE INDEX IF NOT EXISTS retrieval_feedback_slug_idx ON retrieval_feedback (slug);

CREATE TABLE IF NOT EXISTS retrieval_weights (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  weight        REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  n             INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  content_hash  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, slug)
);

CREATE INDEX IF NOT EXISTS retrieval_weights_slug_idx ON retrieval_weights (slug);
