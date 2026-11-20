-- 178_page_purges.sql — the text-free tombstone of an explicitly purged page.
--
-- An explicit purge of named pages records the content hash of each page and
-- of every version it kept. A write whose body hashes to one of them, under
-- any slug of the same source, is refused, so a connector resync, a re-import
-- or a restored snapshot cannot bring the purged text back. Only hashes are
-- kept, one row per purged slug, so clearing one page's tombstones with
-- `memrain unpurge <slug>` leaves another page purged with the same text
-- protected.
CREATE TABLE IF NOT EXISTS page_purges (
  source_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  slug         TEXT NOT NULL,
  purge_id     UUID,
  purged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, content_hash, slug)
);

CREATE INDEX IF NOT EXISTS page_purges_slug_idx ON page_purges (source_id, slug);
