-- 142_admin_reservation_cap.sql — bound how often one setup link or recovery
-- code can be reserved, so a holder cannot keep it away from the owner.
--
-- A browser that redeems a link reserves it for 15 minutes. Without a count,
-- one browser (or one that rotates its pre-auth cookie at every lapse) could
-- retake a link at each lapse and hold it indefinitely. The store counts every
-- new reservation (a lapsed lease or another browser) and refuses once the
-- count reaches its cap. A retry by the same browser inside its live lease is
-- not counted and does not extend the lease.
-- Existing rows start at zero; a constant default makes the add metadata-only.

ALTER TABLE admin_setup_links
  ADD COLUMN IF NOT EXISTS reservations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_recovery_codes
  ADD COLUMN IF NOT EXISTS reservations INTEGER NOT NULL DEFAULT 0;
