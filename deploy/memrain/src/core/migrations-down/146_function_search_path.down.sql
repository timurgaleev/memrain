SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('memrain:migrations'));

DO $down$
BEGIN
  IF (SELECT max(id) FROM migrations) IS DISTINCT FROM 146 THEN
    RAISE EXCEPTION '146 down: migration 146 is not the latest applied migration';
  END IF;
END
$down$;

DO $$
DECLARE
  signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.chunks_update_search_vector()',
    'public.auto_enable_rls()',
    'public.memex_fact_claim_key(text)',
    'public.memrain_fact_claim_key(text)',
    'public.memex_fact_withdrawn_on_insert()',
    'public.memrain_fact_withdrawn_on_insert()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE NOTICE 'Skipping search_path rollback: function % is absent', signature;
      CONTINUE;
    END IF;
    BEGIN
      IF signature = 'public.memex_fact_claim_key(text)' THEN
        EXECUTE format('ALTER FUNCTION %s RESET search_path', signature);
      ELSE
        EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', signature);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping search_path rollback: role % cannot alter %', current_user, signature;
    END;
  END LOOP;
END $$;

DELETE FROM migrations WHERE id = 146;
