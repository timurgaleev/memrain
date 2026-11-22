-- 196_connector_accounts_facts.sql — opt-in paid fact extraction per connector account.
--
-- Mail, chat and meeting pages a connector writes are left out of every paid
-- fact phase. An account may opt in: the connector-facts cycle phase then
-- extracts facts from its pages, under its own daily dollar cap and its own
-- spend client, so a spent facts cap never stops the account's sync.
--
-- Both columns default to off: no account extracts anything, and nothing is
-- paid, until the operator enables it (`memrain connectors facts <id>
-- --enable --cap <usd> --apply`). The cap is bounded at $20 a day.
--
-- Additive with constant defaults, so code from before 196 ignores the columns.

ALTER TABLE connector_accounts
  ADD COLUMN IF NOT EXISTS facts_extraction BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE connector_accounts
  ADD COLUMN IF NOT EXISTS facts_cap_usd_daily NUMERIC(10, 4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connector_accounts_facts_cap_chk'
  ) THEN
    ALTER TABLE connector_accounts
      ADD CONSTRAINT connector_accounts_facts_cap_chk
      CHECK (facts_cap_usd_daily >= 0 AND facts_cap_usd_daily <= 20);
  END IF;
END
$$;
