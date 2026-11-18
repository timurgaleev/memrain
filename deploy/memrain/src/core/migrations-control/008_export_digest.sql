-- Control plane 008: an export receipt names the digest of what it wrote.
--
-- The export is handed to the operator by path and SHA-256; `tenant delete
-- --resume` and the schedule check the files against it under the same fence.

ALTER TABLE tenant_exports ADD COLUMN IF NOT EXISTS sha256 TEXT
  CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');
