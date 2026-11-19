SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 161 THEN
    RAISE EXCEPTION '161 down: migration 161 is not the latest applied migration';
  END IF;
  -- Loops and thread states are rebuilt by the next sync and sweep. The
  -- owner's mutes and closes are not: after a down and an up the loops they
  -- silenced would come back open.
  IF EXISTS (SELECT 1 FROM loop_suppressions) THEN
    RAISE EXCEPTION '161 down: the owner has muted senders or threads; unmute them first (memrain waiting unmute)';
  END IF;
  IF EXISTS (SELECT 1 FROM open_loops WHERE closed_by = 'owner') THEN
    RAISE EXCEPTION '161 down: loops closed by the owner would reopen; delete those rows first if that is acceptable';
  END IF;
END
$down$;

DROP TABLE IF EXISTS loop_suppressions;
DROP TABLE IF EXISTS open_loops;
DROP TABLE IF EXISTS loop_threads;
DELETE FROM migrations WHERE id = 161;
