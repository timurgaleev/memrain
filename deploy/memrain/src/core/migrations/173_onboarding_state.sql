-- 173_onboarding_state.sql — the three-step /app wizard, per member.
--
-- connect → fill → ask. Each marker is the time the step really happened,
-- read from the rows that prove it (a credential's first call, the first
-- page in the member's personal source, the first answer that came back
-- `ok`), and it is never cleared once set, so the wizard only moves
-- forward. `first_answer_at` minus the member's invite `opened_at` is the
-- invite-to-first-answer time, measured by the database, not a stopwatch.
--
-- Only timestamps; no content. The row goes with its member.

CREATE TABLE IF NOT EXISTS onboarding_state (
  member_id        TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  step             TEXT NOT NULL DEFAULT 'connect' CHECK (step IN ('connect', 'fill', 'ask', 'done')),
  connected_at     TIMESTAMPTZ,
  first_write_at   TIMESTAMPTZ,
  first_answer_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
