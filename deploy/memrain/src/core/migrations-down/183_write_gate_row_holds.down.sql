SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 183 THEN
    RAISE EXCEPTION '183 down: migration 183 is not the latest applied migration';
  END IF;
  IF EXISTS (SELECT 1 FROM write_gate_row_holds WHERE status = 'held') THEN
    RAISE EXCEPTION '183 down: rows are still held; release or drop them first (memrain write-gate rows)';
  END IF;
END
$down$;

-- Only holds and their receipts go; no fact, take or timeline row is touched.
DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_row_holds' OR verdict = 'quarantine';
ALTER TABLE write_gate_receipts DROP CONSTRAINT IF EXISTS write_gate_receipts_target_table_check;
ALTER TABLE write_gate_receipts ADD CONSTRAINT write_gate_receipts_target_table_check
  CHECK (target_table IN ('entity_facts', 'synth_takes', 'timeline_events'));
ALTER TABLE write_gate_receipts DROP CONSTRAINT IF EXISTS write_gate_receipts_verdict_check;
ALTER TABLE write_gate_receipts ADD CONSTRAINT write_gate_receipts_verdict_check
  CHECK (verdict IN ('flag'));
DROP TABLE IF EXISTS write_gate_row_holds;
DELETE FROM migrations WHERE id = 183;
