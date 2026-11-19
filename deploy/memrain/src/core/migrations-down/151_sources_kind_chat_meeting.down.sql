SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));
LOCK TABLE sources IN ACCESS EXCLUSIVE MODE;

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 151 THEN
    RAISE EXCEPTION '151 down: migration 151 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM sources WHERE kind IN ('chat', 'meeting')) THEN
    RAISE EXCEPTION '151 down: a chat or meeting source exists; remove it before rolling back';
  END IF;
END
$down$;

ALTER TABLE sources
  DROP CONSTRAINT sources_kind_check;
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
      'other'
    ));
DELETE FROM migrations WHERE id = 151;
