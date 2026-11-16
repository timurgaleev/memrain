-- 166_search_telemetry_shadow.sql — per-day rollup of shadow ranking.
--
-- With MEMRAIN_RANK_SHADOW=<FLAG> set, a search also ranks its candidates a
-- second time with that ranking flag flipped, and records here how the result
-- would have moved. The returned result never changes. Like search_telemetry
-- (089), rows are sums and counts only, so concurrent adds from several
-- processes accumulate, and no query text is stored: the key is a day and a
-- flag name.
--
--   count          searches compared under the flag
--   rank1_changed  of those, how many would have had another top document
--   sum_jaccard5   sum of the Jaccard overlap of the top-5 documents

CREATE TABLE IF NOT EXISTS search_telemetry_shadow (
  date           TEXT             NOT NULL,
  flag           TEXT             NOT NULL CHECK (flag ~ '^[A-Z0-9_]{1,64}$'),
  count          INTEGER          NOT NULL DEFAULT 0 CHECK (count >= 0),
  rank1_changed  INTEGER          NOT NULL DEFAULT 0 CHECK (rank1_changed >= 0),
  sum_jaccard5   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (sum_jaccard5 >= 0),
  first_seen     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, flag),
  CHECK (rank1_changed <= count),
  CHECK (sum_jaccard5 <= count)
);
