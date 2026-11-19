-- 151_sources_kind_chat_meeting.sql — admit the `chat` and `meeting` source kinds.
--
-- Chat connectors (one page per channel and day) and meeting connectors
-- (transcripts and their summary pages) write into a source of their own
-- kind, so a connector run can never land pages in a vault or a tenant's
-- notes by a typo, and readers can frame those pages as outside text by kind.
-- Same replace-the-CHECK pattern as migrations 012 and 113.

ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_kind_check
    CHECK (kind IN (
      'vault',
      'memory',
      'webhook',
      'mailbox',
      'calendar',
      'transcript',
      'code',
      'github',
      'chat',
      'meeting',
      'other'
    ));
