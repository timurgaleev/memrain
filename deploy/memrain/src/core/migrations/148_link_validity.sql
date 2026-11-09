ALTER TABLE links ADD COLUMN IF NOT EXISTS valid_from DATE;
ALTER TABLE links ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE links ADD CONSTRAINT links_validity_interval
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until);
