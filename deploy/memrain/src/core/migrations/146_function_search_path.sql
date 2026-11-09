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
      RAISE NOTICE 'Skipping search_path hardening: function % is absent', signature;
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', signature);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping search_path hardening: role % cannot alter %', current_user, signature;
    END;
  END LOOP;
END $$;
