-- 123_access_tokens_grant_revision.sql — revision for personal access token grants.
--
-- Changing a token's scopes (up to admin), takes-holder list or daily cap used
-- to be a blind UPDATE with no trace. Each such change now bumps the token's
-- `grant_revision` and writes one oauth_grant_audit row keyed `pat:<id>` in the
-- same statement, exactly as a client rescope does (migration 110).
--
-- Additive: existing tokens start at revision 0. A re-apply after the down
-- migration resumes each token at the highest revision its audit rows already
-- carry, so the (client_id, revision) key of the kept history never collides.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS grant_revision INTEGER NOT NULL DEFAULT 0;

UPDATE access_tokens t
   SET grant_revision = a.max_revision
  FROM (SELECT client_id, max(revision) AS max_revision
          FROM oauth_grant_audit
         WHERE client_id LIKE 'pat:%'
         GROUP BY client_id) a
 WHERE a.client_id = 'pat:' || t.id::text
   AND t.grant_revision < a.max_revision;
