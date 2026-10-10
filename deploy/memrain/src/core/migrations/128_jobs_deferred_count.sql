-- 128_jobs_deferred_count.sql — count the times a job waited out an outage.
--
-- When Bedrock is down for everyone (expired credentials, a model not enabled,
-- a spent quota, sustained throttling), a queued job that hits it is put back
-- to wait for the outage instead of spending a retry. This column counts those
-- waits, so a failure that only looks like an outage cannot keep a job waiting
-- forever: past the cap the worker fails it the ordinary way.
--
-- Additive; existing rows start at 0. No index: read only on the claimed row.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deferred_count INTEGER NOT NULL DEFAULT 0;
