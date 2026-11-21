-- 188_entity_dedupe_rejections.sql — pairs of person or company pages the
-- owner said are different entities.
--
-- `memrain dedupe --preview` lists pages that share an email, phone, handle,
-- LinkedIn, GitHub, domain or declared id. `memrain dedupe reject <a> <b>`
-- records here that two of them are not one entity, so the pair is never
-- proposed again: by its slugs, and by each page's fingerprint (a hash of its
-- kind, its name without titles or company suffixes, and its strong key
-- values; never the values themselves), so a rename keeps the pair apart. A
-- page with no strong key has no fingerprint and stays apart by slug.
--
-- a_slug sorts before b_slug. Rows go with their source.
CREATE TABLE IF NOT EXISTS entity_dedupe_rejections (
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  a_slug         TEXT NOT NULL,
  b_slug         TEXT NOT NULL,
  a_fingerprint  TEXT,
  b_fingerprint  TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, a_slug, b_slug),
  CHECK (a_slug <> b_slug)
);
