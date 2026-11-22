-- 191_embeddings_halfvec.sql — store chunk embeddings at half precision.
--
-- embeddings.vector becomes halfvec(N) (2 bytes per dimension instead of 4)
-- with an HNSW index on halfvec_cosine_ops. Table and index both halve, so the
-- index fits a small instance's cache instead of being read from disk on every
-- search. Existing vectors are cast in place: nothing is re-embedded. Titan
-- vectors are unit-length with components well inside half precision; cosine
-- distances move by about 1e-3, which keeps clear nearest neighbours in order.
--
-- pgvector without halfvec (< 0.7) keeps vector(N): the migration records
-- itself and changes nothing. The code reads the column type from the catalog
-- (core/embedding-column.ts), so either shape works.
--
-- Cost: the column change rewrites the table and the HNSW index is rebuilt
-- under the migration's ACCESS EXCLUSIVE lock on `embeddings`. Until COMMIT,
-- vector search, re-ranking and embedding writes wait; queries that never read
-- `embeddings` (keyword, title) keep running. The build is deliberately NOT
-- CONCURRENTLY: a concurrent build keeps two indexes alive at once, the memory
-- shape that exhausted a 1 GB instance. Parallel build workers are off so the
-- graph lives in one backend's maintenance_work_mem and no extra workers start.
-- On a large brain run it in a maintenance window with the app stopped.
DO $mig$
DECLARE
  col_type text;
  dims integer;
  idx record;
  keep_main boolean;
BEGIN
  SELECT t.typname, a.atttypmod INTO col_type, dims
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = 'embeddings'::regclass
     AND a.attname = 'vector'
     AND NOT a.attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION '191: embeddings.vector not found';
  END IF;

  IF to_regtype('halfvec') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_opclass o JOIN pg_am am ON am.oid = o.opcmethod
                     WHERE o.opcname = 'halfvec_cosine_ops' AND am.amname = 'hnsw') THEN
    IF col_type = 'halfvec' THEN
      RAISE EXCEPTION '191: embeddings.vector is halfvec but pgvector has no hnsw halfvec_cosine_ops';
    END IF;
    RAISE NOTICE '191: pgvector has no halfvec; embeddings.vector stays vector';
    RETURN;
  END IF;

  IF col_type NOT IN ('vector', 'halfvec') THEN
    RAISE EXCEPTION '191: embeddings.vector has unexpected type %', col_type;
  END IF;
  IF dims IS NULL OR dims <= 0 THEN
    RAISE EXCEPTION '191: embeddings.vector has no fixed width';
  END IF;

  -- A converted column whose index is already right keeps it; only what is
  -- missing or wrong is (re)built.
  keep_main := col_type = 'halfvec' AND EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_opclass o ON o.oid = i.indclass[0]
     WHERE i.indrelid = 'embeddings'::regclass
       AND c.relname = 'embeddings_vector_idx'
       AND i.indisvalid
       AND o.opcname = 'halfvec_cosine_ops'
  );

  PERFORM set_config('max_parallel_maintenance_workers', '0', true);

  -- The production index and whatever an interrupted rebuild left of it
  -- (REINDEX CONCURRENTLY's _ccnew/_ccold, `memrain hnsw rebuild`'s _rebuild_*).
  -- Any other index on the column makes the ALTER below fail and roll back.
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'embeddings'::regclass
       AND ((c.relname = 'embeddings_vector_idx' AND NOT keep_main)
            OR c.relname LIKE 'embeddings\_vector\_idx\_ccnew%'
            OR c.relname LIKE 'embeddings\_vector\_idx\_ccold%'
            OR c.relname LIKE 'embeddings\_vector\_idx\_rebuild\_%')
  LOOP
    EXECUTE format('DROP INDEX %I', idx.relname);
  END LOOP;

  IF col_type = 'vector' THEN
    EXECUTE format(
      'ALTER TABLE embeddings ALTER COLUMN vector TYPE halfvec(%s) USING vector::halfvec(%s)',
      dims, dims);
  END IF;

  IF NOT keep_main THEN
    EXECUTE 'CREATE INDEX embeddings_vector_idx ON embeddings USING hnsw (vector halfvec_cosine_ops)';
  END IF;
END
$mig$;
