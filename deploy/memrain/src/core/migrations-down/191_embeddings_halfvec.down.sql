SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30min';
SET LOCAL max_parallel_maintenance_workers = 0;
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 191 THEN
    RAISE EXCEPTION '191 down: migration 191 is not the latest applied migration';
  END IF;
END
$down$;

-- Back to single precision. The values stay what halfvec held (the cast up
-- rounded them; casting back is exact), so search behaves as it did on the
-- converted column. Same lock and cost as the way up: a table rewrite and a
-- non-concurrent HNSW build while `embeddings` is locked.
DO $down$
DECLARE
  col_type text;
  dims integer;
  idx record;
BEGIN
  SELECT t.typname, a.atttypmod INTO col_type, dims
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = 'embeddings'::regclass
     AND a.attname = 'vector'
     AND NOT a.attisdropped;

  IF col_type IS DISTINCT FROM 'halfvec' THEN
    RETURN;
  END IF;

  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'embeddings'::regclass
       AND (c.relname = 'embeddings_vector_idx'
            OR c.relname LIKE 'embeddings\_vector\_idx\_ccnew%'
            OR c.relname LIKE 'embeddings\_vector\_idx\_ccold%'
            OR c.relname LIKE 'embeddings\_vector\_idx\_rebuild\_%')
  LOOP
    EXECUTE format('DROP INDEX %I', idx.relname);
  END LOOP;

  EXECUTE format(
    'ALTER TABLE embeddings ALTER COLUMN vector TYPE vector(%s) USING vector::vector(%s)',
    dims, dims);
  EXECUTE 'CREATE INDEX embeddings_vector_idx ON embeddings USING hnsw (vector vector_cosine_ops)';
END
$down$;

DELETE FROM migrations WHERE id = 191;
