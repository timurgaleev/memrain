-- 155_daemon_controls.sql — operator and scheduler state for background daemons.
--
-- One row per (daemon, source). daemon '*' is every daemon and source_id '*'
-- every source, so a pause can be as broad or as narrow as needed. A NULL
-- `enabled`, `cron`, `timezone` or cap means "use the daemon's built-in value".
-- Run history is not kept here: a daemon's runs are its rows in `jobs`.
CREATE TABLE IF NOT EXISTS daemon_controls (
  daemon               TEXT NOT NULL,
  source_id            TEXT NOT NULL DEFAULT '*',
  enabled              BOOLEAN,
  paused               BOOLEAN NOT NULL DEFAULT false,
  paused_reason        TEXT,
  paused_by            TEXT,
  paused_at            TIMESTAMPTZ,
  cron                 TEXT,
  timezone             TEXT,
  cap_usd_per_day      NUMERIC,
  cap_usd_per_run      NUMERIC,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_window          TEXT,
  last_run_at          TIMESTAMPTZ,
  last_outcome         TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (daemon, source_id),
  CONSTRAINT daemon_controls_failures_chk CHECK (consecutive_failures >= 0),
  CONSTRAINT daemon_controls_caps_chk CHECK (
    (cap_usd_per_day IS NULL OR cap_usd_per_day >= 0)
    AND (cap_usd_per_run IS NULL OR cap_usd_per_run >= 0))
);
