-- 127_cycle_phase_runs.sql — when each cycle phase last ran.
--
-- The paid synthesis phases (concepts, contradictions, reflections, patterns,
-- ...) used to run on every quiet-hours tick, so a shorter cycle interval
-- multiplied their bill. The cycle now records each phase's last run here and
-- runs a synthesis phase at most once per UTC day
-- (MEMRAIN_SYNTHESIS_ONCE_PER_DAY, on by default).
--
--   phase        the cycle phase name
--   last_run_at  when its last run finished, whatever the outcome
--   last_status  ok | warn | fail
--
-- One row per phase, overwritten on every run. Writes are best-effort: a
-- missing row only means the phase is not held back.

CREATE TABLE IF NOT EXISTS cycle_phase_runs (
  phase        TEXT PRIMARY KEY,
  last_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status  TEXT NOT NULL
);
