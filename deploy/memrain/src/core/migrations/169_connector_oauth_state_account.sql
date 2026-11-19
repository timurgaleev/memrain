-- 169_connector_oauth_state_account.sql — the account a reconnect is for.
--
-- A Reconnect on an account row names that account. The callback then
-- renews only that row and refuses a grant for anyone else
-- (`identity_mismatch`), instead of adding the other account to the row's
-- source. NULL for a first connect. A state lives minutes; an account
-- deleted meanwhile takes its pending states with it.
ALTER TABLE connector_oauth_states
  ADD COLUMN IF NOT EXISTS account_id UUID NULL REFERENCES connector_accounts(id) ON DELETE CASCADE;
