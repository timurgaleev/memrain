-- 161_open_loops.sql — who is waiting on whom, worked out without a model.
--
-- loop_threads: the reply state of one connector page, as the renderer read it
-- from the provider's own fields: per message, when it was sent, whether the
-- account sent it, whether the account was in To, and flags for list mail,
-- auto-replies, calendar notices, questions, promises and thank-you-only
-- replies. Chat days of one direct conversation share a thread_ref, so the
-- loop detector reads them as one thread. No message body is kept here.
--
-- open_loops: what the detector concluded. A loop is never deleted to close it:
-- its status moves to done, dropped or stale and `closed_by` says why (a short
-- code, never text). `summary` is a line built from the page title and the
-- counterparty's name, both outside text that readers frame as such.
-- `counterparty_key` is a hash of the address, which is what a mute matches.
--
-- loop_suppressions: the owner's mutes, by sender (address hash) or thread.
-- A mute stops new loops; it never closes or rewrites existing ones.
--
-- Every row belongs to the source of the page it came from and goes with the
-- source; thread and loop rows also go with their page.
CREATE TABLE IF NOT EXISTS loop_threads (
  page_slug        TEXT PRIMARY KEY REFERENCES pages(slug) ON DELETE CASCADE,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('mail', 'chat', 'calendar')),
  thread_ref       TEXT NOT NULL CHECK (thread_ref ~ '^[0-9a-f]{16}$'),
  signals          JSONB NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS loop_threads_thread_idx ON loop_threads (source_id, thread_ref);
CREATE INDEX IF NOT EXISTS loop_threads_activity_idx ON loop_threads (source_id, last_activity_at);

CREATE TABLE IF NOT EXISTS open_loops (
  id               BIGSERIAL PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dedup_key        TEXT NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),
  loop_type        TEXT NOT NULL CHECK (loop_type IN (
                     'unanswered_inbound', 'unanswered_outbound', 'commitment_owed_by_me',
                     'commitment_owed_to_me', 'rsvp_owed', 'decision_pending')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped', 'stale')),
  detector         TEXT NOT NULL CHECK (detector IN ('deterministic', 'llm_extract', 'manual')),
  kind             TEXT NOT NULL CHECK (kind IN ('mail', 'chat', 'calendar', 'meeting')),
  thread_ref       TEXT CHECK (thread_ref IS NULL OR thread_ref ~ '^[0-9a-f]{16}$'),
  page_slug        TEXT REFERENCES pages(slug) ON DELETE CASCADE,
  counterparty_label TEXT CHECK (counterparty_label IS NULL OR length(counterparty_label) <= 300),
  counterparty_key TEXT CHECK (counterparty_key IS NULL OR counterparty_key ~ '^[0-9a-f]{16}$'),
  summary          TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at           TIMESTAMPTZ,
  confidence       REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  fact_id          BIGINT REFERENCES entity_facts(id) ON DELETE SET NULL,
  opened_at        TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  closed_at        TIMESTAMPTZ,
  closed_by        TEXT CHECK (closed_by IS NULL OR closed_by ~ '^[a-z_]{1,40}$'),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, dedup_key),
  CHECK ((status = 'open') = (closed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS open_loops_open_idx ON open_loops (source_id, last_activity_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS open_loops_thread_idx ON open_loops (source_id, thread_ref);
CREATE INDEX IF NOT EXISTS open_loops_page_idx ON open_loops (page_slug);
CREATE INDEX IF NOT EXISTS open_loops_fact_idx ON open_loops (fact_id) WHERE fact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS loop_suppressions (
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('sender', 'thread')),
  value_hash TEXT NOT NULL CHECK (value_hash ~ '^[0-9a-f]{16}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, kind, value_hash)
);
