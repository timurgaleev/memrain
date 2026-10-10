-- 136_wanted_links.sql — authored links whose target page does not exist yet.
--
-- The wikilink scanner dropped an unresolved `[Name](path)` link and kept a
-- dangling `[[name]]` only as an `unqualified` edge onto a slugified target.
-- Nothing re-extracted the linking page when the target page appeared later,
-- so the edge never reached it. Each such reference is now recorded here,
-- replaced together with the page's wikilink edges; a page write that creates
-- the target (or declares it as an alias) reconnects the rows in its own
-- transaction and deletes them.
--
--   wanted_links.source_id    the linking page's source (the edge's source)
--   wanted_links.from_slug    the linking page; its delete drops the rows
--   wanted_links.target_slug  the slugified target the link names
--   wanted_links.surface      the reference as written, first one seen
--   wanted_links.first_seen   when the dangling link was first recorded
--
-- Rows are derived state: the page text stays the source of truth. Additive.

CREATE TABLE IF NOT EXISTS wanted_links (
  source_id   TEXT        NOT NULL DEFAULT 'default',
  from_slug   TEXT        NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  target_slug TEXT        NOT NULL,
  surface     TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, from_slug, target_slug)
);

-- The reconnect on a page write looks rows up by target.
CREATE INDEX IF NOT EXISTS wanted_links_target_idx
  ON wanted_links (target_slug, source_id);

-- The scanner replaces one page's rows at a time.
CREATE INDEX IF NOT EXISTS wanted_links_from_idx
  ON wanted_links (from_slug);
