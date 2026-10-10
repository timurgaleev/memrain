-- 124_retire_dead_scopes.sql — drop the `sources_admin` and `users_admin` scopes.
--
-- Both names were accepted at registration and on token rows, but no operation
-- ever required either one, and `admin` implied both. They granted nothing, so
-- removing them from stored grants changes no caller's access. The server no
-- longer accepts them on a client or a token.
--
-- The columns, as migration 046 created them:
--   oauth_clients.scope   TEXT    (space-separated, the OAuth wire form)
--   access_tokens.scopes  TEXT[]
--   oauth_tokens.scopes   TEXT[]
--   oauth_codes.scopes    TEXT[]
-- The type is read from the catalog rather than assumed, and a column of any
-- other type stops the migration instead of being rewritten blind. A JSONB
-- array (never created by this schema) is handled the same way as TEXT[].
--
-- Idempotent: only rows that still carry a retired name are touched, so a
-- second run changes nothing. oauth_grant_audit rows are history and are left
-- as written. A client whose scope string held nothing else ends up with an
-- empty scope, which grants nothing — as before.
DO $retire$
DECLARE
  col  record;
  kind text;
BEGIN
  FOR col IN
    SELECT * FROM (VALUES
      ('oauth_clients', 'scope'),
      ('access_tokens', 'scopes'),
      ('oauth_tokens',  'scopes'),
      ('oauth_codes',   'scopes')
    ) AS v(tbl, colname)
  LOOP
    SELECT c.udt_name INTO kind
      FROM information_schema.columns c
     WHERE c.table_schema = current_schema()
       AND c.table_name = col.tbl
       AND c.column_name = col.colname;
    IF kind IS NULL THEN
      RAISE EXCEPTION '124: column %.% not found', col.tbl, col.colname;
    ELSIF kind = '_text' THEN
      EXECUTE format(
        'UPDATE %I SET %I = array_remove(array_remove(%I, %L), %L) WHERE %I && ARRAY[%L, %L]::text[]',
        col.tbl, col.colname, col.colname, 'sources_admin', 'users_admin',
        col.colname, 'sources_admin', 'users_admin');
    ELSIF kind = 'text' THEN
      EXECUTE format(
        'UPDATE %I SET %I = array_to_string(ARRAY(
            SELECT s FROM unnest(regexp_split_to_array(%I, %L)) AS s
             WHERE s <> %L AND s NOT IN (%L, %L)), %L)
          WHERE %I ~ %L',
        col.tbl, col.colname, col.colname, '\s+', '', 'sources_admin', 'users_admin', ' ',
        col.colname, '(^|\s)(sources_admin|users_admin)(\s|$)');
    ELSIF kind = 'jsonb' THEN
      EXECUTE format(
        'UPDATE %I SET %I = (SELECT COALESCE(jsonb_agg(e), %L::jsonb)
                               FROM jsonb_array_elements(%I) AS e
                              WHERE e NOT IN (to_jsonb(%L::text), to_jsonb(%L::text)))
          WHERE jsonb_typeof(%I) = %L AND (%I ? %L OR %I ? %L)',
        col.tbl, col.colname, '[]', col.colname, 'sources_admin', 'users_admin',
        col.colname, 'array', col.colname, 'sources_admin', col.colname, 'users_admin');
    ELSE
      RAISE EXCEPTION '124: column %.% has unexpected type %', col.tbl, col.colname, kind;
    END IF;
  END LOOP;
END
$retire$;
