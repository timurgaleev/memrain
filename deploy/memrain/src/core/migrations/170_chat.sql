-- 170_chat.sql — the admin "Ask" page's conversations.
--
-- A thread belongs to one owner (`owner_key`: `operator` today, a member id
-- later) and to the source its answers were read for; deleting the source
-- takes its threads. A message is a turn: the user's question, or the
-- assistant's answer with the citations, gaps, model, cost and a short trace
-- of how it was found (slugs and counts only, never page bodies; capped at
-- 16 KB by the writer).
--
-- `cost_usd` is a display snapshot; the spend ledger stays the account of
-- record. NULL means the cost is unknown, never a free call.
-- `saved_slug` names the page an answer was saved as. It is a pointer, not a
-- reference: purging that page leaves the answer as it was.
--
-- Chat history is personal data: a thread is deleted outright (no soft
-- delete), the retention task removes old messages, and `memrain erase chat`
-- removes an owner's threads.
CREATE TABLE IF NOT EXISTS chat_threads (
  id          UUID PRIMARY KEY,
  owner_key   TEXT NOT NULL CHECK (length(owner_key) BETWEEN 1 AND 200),
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title       TEXT CHECK (title IS NULL OR length(title) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_threads_owner_idx ON chat_threads (owner_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_threads_source_idx ON chat_threads (source_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id             BIGSERIAL PRIMARY KEY,
  thread_id      UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content        TEXT NOT NULL,
  model          TEXT,
  citations      JSONB,
  trace          JSONB,
  gaps           JSONB,
  cost_usd       DOUBLE PRECISION CHECK (cost_usd IS NULL OR cost_usd >= 0),
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  status         TEXT CHECK (status IS NULL OR status IN ('ok', 'refused', 'budget', 'error', 'disabled')),
  saved_slug     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages (thread_id, id);
CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages (created_at);
