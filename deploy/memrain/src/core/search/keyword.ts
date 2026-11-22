/**
 * Keyword retrieval — tsvector plainto_tsquery + ts_rank_cd.
 *
 * Ranks against the weighted `search_vector` (migration 030): a chunk's
 * symbol identity (symbol_name + parent_symbol_path, code chunks only) sits
 * at weight 'A' above its body text at weight 'B', so a query that names a
 * symbol ranks that chunk above prose-only mentions. Markdown chunks have an
 * empty 'A' segment, so their lexemes all land at 'B' — a uniform shift that
 * leaves their relative order unchanged. Config stays 'simple', so the
 * matched set is identical to the old un-weighted `ts` for markdown chunks.
 *
 * NOTE: that order-preservation for markdown holds ONLY because `ts_rank_cd`
 * is called with no normalization flag — a uniform per-lexeme weight shift
 * then scales every markdown doc's rank by the same constant. If a
 * length-normalization flag (e.g. `| 2`) is ever added here, the factor stops
 * cancelling and markdown ordering can shift; re-validate the retrieval gates
 * before doing so.
 *
 * Both engines treat the `to_tsvector('simple', ...)` GENERATED column the
 * same way. `plainto_tsquery` lowercases / strips operators so callers
 * can pass user input verbatim.
 */
import { scanIdentifierProbe } from "./identifier-probe.ts";
import type { Engine } from "../engine/interface.ts";
import { visibilityClause } from "../visibility.ts";
import { chunkFilterClauses, type ChunkFilters } from "./filters.ts";
import {
  buildCurationBoostCaseSql,
  buildHardExcludeClauseSql,
} from "./curation.ts";

export interface KeywordSearchOptions {
  sourceIds?: readonly string[];
  /**
   * Pushed-down lang / symbol_kind / since / until predicates. Folded into the
   * WHERE clause so the LIMIT budget is spent on rows that already match — a
   * filtered match ranking below the fanout is no longer dropped. See filters.ts.
   */
  filters?: ChunkFilters;
  /**
   * Per-page max-pool (opt-in, default OFF): collapse the candidate set to ONE
   * row per (source, document) — the page's highest-ranking chunk — BEFORE the
   * LIMIT cut, so the budget covers N distinct pages (each by its best chunk)
   * instead of N chunks that may all belong to a few noisy pages. Deterministic
   * DISTINCT ON; the surviving chunk is fully pinned by the `score DESC, id`
   * tiebreak. See hybrid.ts (`maxPool`).
   */
  maxPool?: boolean;
  /**
   * Curation prefix boost inside the arm SQL: multiply the
   * FTS rank by the per-prefix authority factor BEFORE the LIMIT cut, so a
   * curated page's chunk survives the fanout over bulk-feed noise. The caller
   * (hybrid.ts) disables it for temporal queries — freshness queries must not
   * be steered toward evergreen tiers. Default OFF preserves prior ordering.
   */
  sourceBoost?: boolean;
}

export async function keywordSearch(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<string[]> {
  const rows = await keywordSearchScored(engine, query, limit, opts);
  return rows.map((row) => row.id);
}

/** One keyword-arm row: the chunk, its page, and the arm's own rank score. */
export interface KeywordRow {
  id: string;
  documentId: string;
  score: number;
}

/** {@link keywordSearch} with each row's document and FTS score kept. */
export async function keywordSearchScored(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<KeywordRow[]> {
  return runKeywordQuery(engine, [query], "plainto_tsquery('simple', $1)", limit, opts);
}

/** The same keyword query, restricted to identifiers when prose makes the full AND too narrow. */
export async function keywordIdentifierSearch(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<KeywordRow[]> {
  const { tokens, hasProse, incomplete } = scanIdentifierProbe(query);
  if (incomplete) throw new Error("identifier probe limit exceeded");
  if (tokens.length === 0 || !hasProse) return [];
  const tsquery = `(${tokens.map((_, i) => `plainto_tsquery('simple', $${i + 1})`).join(" && ")})`;
  return runKeywordQuery(engine, tokens, tsquery, limit, opts);
}

/**
 * Chunks that contain `name` as a phrase, ranked by the phrase OR each of
 * `terms` (the query's other content words), for the alias fan-out: a record
 * filed under one of an entity's names need not hold every other query word,
 * only the name. Every value is its own bound parameter, so neither the name
 * nor a term is ever spliced into a tsquery string.
 */
export async function keywordSearchAliasRequired(
  engine: Engine,
  name: string,
  terms: readonly string[],
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<string[]> {
  if (!/[\p{L}\p{N}]/u.test(name)) return [];
  const phrase = "phraseto_tsquery('simple', $1)";
  const rank = `(${[phrase, ...terms.map((_, i) => `plainto_tsquery('simple', $${i + 2})`)].join(" || ")})`;
  const rows = await runKeywordQuery(engine, [name, ...terms], rank, limit, opts, undefined, phrase);
  return rows.map((row) => row.id);
}

/** Lexemes past this many are dropped from the OR form: a long query already found its AND rows or it is prose. */
const MAX_RELAXED_LEXEMES = 16;

/** Shorter lexemes match too many chunks to be a useful OR term. */
const MIN_RELAXED_LEXEME_LENGTH = 3;

/**
 * Function words the 'simple' config keeps. In an OR any one of them matches
 * most chunks and fills the LIMIT before the content words rank, so they never
 * enter the retry. English and German, the brain's two languages; words under
 * {@link MIN_RELAXED_LEXEME_LENGTH} are dropped anyway and are not listed.
 */
export const RELAXED_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "was", "were", "with", "from",
  "this", "that", "these", "those", "there", "their", "they", "them", "then",
  "than", "what", "when", "where", "which", "who", "whom", "why", "how",
  "about", "into", "onto", "over", "also", "been", "being", "have", "has",
  "had", "does", "did", "its", "can", "will", "would", "should", "could",
  "you", "your", "our", "his", "her", "all", "any", "some",
  "der", "die", "das", "und", "den", "dem", "des", "ein", "eine", "einer",
  "eines", "einem", "einen", "mit", "von", "für", "auf", "ist", "sind",
  "nicht", "auch", "als", "wie", "wer", "aus", "bei", "nach", "über",
  "oder", "aber", "sich", "wir", "ihr", "sie", "zum", "zur", "dass", "noch",
  "nur", "war", "wird", "werden", "kann", "hat", "haben",
]);

/** A lexeme matching at most this many chunks is rare; its count stops one past it. */
export const RARE_LEXEME_CHUNK_CAP = 400;

/**
 * The OR form of {@link keywordSearch}: a chunk matching ANY of the query's
 * content lexemes. Hybrid search uses it to fill a keyword-only result the
 * strict AND pass left short. The lexemes come from the same 'simple' parser
 * the AND form uses, in query order (the cap keeps the words the caller typed
 * first), and each goes back in as its own bound parameter, so no user text is
 * ever spliced into a tsquery string. A query with fewer than two lexemes has
 * no OR form, and one left with no content lexeme has nothing to match: both
 * return [].
 *
 * ts_rank knows no term rarity: a chunk naming a common word three times
 * outranks the one page holding the rare word. So the chunks holding a rare
 * lexeme (one matching at most RARE_LEXEME_CHUNK_CAP chunks, counted with a
 * bounded read) come first, ordered by the summed 1/count of the rare lexemes
 * they hold, then by ts_rank over the whole OR; chunks holding only common
 * lexemes follow in ts_rank order.
 */
export async function keywordSearchRelaxed(
  engine: Engine,
  query: string,
  limit: number,
  opts: KeywordSearchOptions = {},
): Promise<KeywordRow[]> {
  // One word has no OR form; skip the round trip that would only say so.
  if ((query.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2) return [];
  const lex = await engine.query<{ lex: string }>(
    `SELECT lexeme AS lex FROM unnest(to_tsvector('simple', $1)) ORDER BY positions[1], lexeme`,
    [query],
  );
  const all = lex.rows.map((r) => r.lex).filter(Boolean);
  if (all.length < 2) return [];
  const lexemes = all
    .filter((l) => l.length >= MIN_RELAXED_LEXEME_LENGTH && !RELAXED_STOPWORDS.has(l))
    .slice(0, MAX_RELAXED_LEXEMES);
  if (lexemes.length === 0) return [];
  const tsquery = `(${lexemes.map((_, i) => `plainto_tsquery('simple', $${i + 1})`).join(" || ")})`;
  // The rarity read only orders the rows: when it fails, the plain OR still answers.
  const counts = await lexemeChunkCounts(engine, lexemes, opts.sourceIds, opts.filters).catch(() => null);
  if (counts === null) return runKeywordQuery(engine, lexemes, tsquery, limit, opts);
  const rare = lexemes
    .map((l, i) => ({ index: i, count: counts.get(l) ?? 0 }))
    .filter((t) => t.count > 0 && t.count <= RARE_LEXEME_CHUNK_CAP)
    .map((t) => ({ index: t.index, weight: 1 / t.count }));
  if (rare.length === 0) return runKeywordQuery(engine, lexemes, tsquery, limit, opts);
  const first = await runKeywordQuery(engine, lexemes, tsquery, limit, opts, rare);
  if (first.length >= limit) return first;
  const seen = new Set(first.map((r) => r.id));
  const rest = await runKeywordQuery(engine, lexemes, tsquery, limit, opts);
  return [...first, ...rest.filter((r) => !seen.has(r.id))].slice(0, limit);
}

/** Chunks matching each lexeme, counted up to one past RARE_LEXEME_CHUNK_CAP, in the caller's scope and filters. */
async function lexemeChunkCounts(
  engine: Engine,
  lexemes: readonly string[],
  sourceIds: readonly string[] | undefined,
  filters: ChunkFilters | undefined,
): Promise<Map<string, number>> {
  const params: unknown[] = [lexemes, RARE_LEXEME_CHUNK_CAP + 1];
  let sourceFilter = "";
  if (sourceIds !== undefined) {
    params.push(sourceIds);
    sourceFilter = ` AND d.source_id = ANY($3::text[])`;
  }
  sourceFilter += chunkFilterClauses(params, filters);
  const r = await engine.query<{ lex: string; n: number | string }>(
    `SELECT u.lex,
            (SELECT count(*)::int FROM (
               SELECT 1 FROM chunks c
                 JOIN documents d ON d.id = c.document_id
                WHERE c.search_vector @@ plainto_tsquery('simple', u.lex)
                  AND ${visibilityClause("d")}${sourceFilter}${buildHardExcludeClauseSql("d.source_path")}
                LIMIT $2::int) x) AS n
       FROM unnest($1::text[]) AS u(lex)`,
    params,
  );
  return new Map(r.rows.map((row) => [row.lex, Number(row.n)]));
}

/**
 * The keyword arm's SQL, parameterised on the tsquery expression. The query
 * text params are `$1..$n` (`queryParams`); every other param is appended after
 * them. With `rare` (indexes into `queryParams` and their weights), only chunks
 * holding one of those lexemes match, ordered by the summed weight of the ones
 * they hold before the rank score. With `matchTsquery`, rows must match it
 * while `tsquery` only ranks them.
 */
async function runKeywordQuery(
  engine: Engine,
  queryParams: readonly string[],
  tsquery: string,
  limit: number,
  opts: KeywordSearchOptions,
  rare?: ReadonlyArray<{ index: number; weight: number }>,
  matchTsquery?: string,
): Promise<KeywordRow[]> {
  // `undefined` is unscoped (operator, CLI, every pre-tenancy caller). An
  // EMPTY array is a caller granted nothing: the predicate still goes on and
  // `= ANY('{}')` matches no row. Collapsing the two — `opts.sourceIds ?? []`
  // plus a length check — handed the caller with no grant the whole brain.
  const sourceIds = opts.sourceIds;
  const vis = visibilityClause("d");
  // Join documents so the visibility filter (deleted/archived/quarantine)
  // applies — soft-deleted/quarantined docs must never be candidates.
  const params: unknown[] = [...queryParams];
  let sourceFilter = "";
  if (sourceIds !== undefined) {
    params.push(sourceIds);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const filterClauses = chunkFilterClauses(params, opts.filters);
  // Default hard-excludes (test fixtures / attachments / raw sidecars) are
  // pushed into the WHERE so noise never consumes LIMIT budget.
  const excludeClause = buildHardExcludeClauseSql("d.source_path");
  // Per-prefix authority factor folded into the ranking expression (LIMIT
  // shaping); '1.0' when disabled so the SQL shape stays uniform.
  const boostCase = opts.sourceBoost ? buildCurationBoostCaseSql("d.source_path") : "1.0";
  // The plain arm's SQL is unchanged when there is no rarity to rank by.
  let match = matchTsquery ?? tsquery;
  let rarityCol = "";
  let byRarity = "";
  let byPooledRarity = "";
  if (rare && rare.length > 0) {
    match = `(${rare.map((t) => `plainto_tsquery('simple', $${t.index + 1})`).join(" || ")})`;
    const rarity = rare.map((t) => {
      params.push(t.weight);
      return `CASE WHEN c.search_vector @@ plainto_tsquery('simple', $${t.index + 1}) THEN $${params.length}::float8 ELSE 0 END`;
    }).join(" + ");
    rarityCol = `, (${rarity}) AS rarity`;
    byRarity = "rarity DESC, ";
    byPooledRarity = "bpp.rarity DESC, ";
  }
  params.push(limit);
  const limitParam = `$${params.length}`;
  // Per-page max-pool (opt-in): pool the full match set to the best chunk per
  // (source, document) BEFORE the LIMIT, so a page's top chunk can't be
  // truncated out by weaker chunks of OTHER pages filling the early slots. The
  // inner DISTINCT ON leads its ORDER BY with the collapse key (required), then
  // the tiebreak `score DESC, id` pins the surviving chunk deterministically;
  // the outer query re-ranks the pooled rows by score. Same matched set + WHERE
  // as the flat path — only the per-page collapse differs.
  const sql = opts.maxPool
    ? `SELECT bpp.id, bpp.document_id, bpp.score FROM (
         SELECT DISTINCT ON (COALESCE(d.source_id, 'default'), c.document_id)
                c.id AS id,
                c.document_id AS document_id,
                ts_rank_cd(c.search_vector, ${tsquery}) * ${boostCase} AS score${rarityCol}
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.search_vector @@ ${match}
            AND ${vis}${sourceFilter}${filterClauses}${excludeClause}
          ORDER BY COALESCE(d.source_id, 'default'), c.document_id,
                   ${byRarity}score DESC, c.id COLLATE "C" ASC
       ) bpp
       ORDER BY ${byPooledRarity}bpp.score DESC, bpp.id COLLATE "C" ASC
       LIMIT ${limitParam}`
    : `SELECT c.id, c.document_id,
              ts_rank_cd(c.search_vector, ${tsquery}) * ${boostCase} AS score${rarityCol}
         FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.search_vector @@ ${match}
         AND ${vis}${sourceFilter}${filterClauses}${excludeClause}
       ORDER BY ${byRarity}score DESC, c.id COLLATE "C" ASC
       LIMIT ${limitParam}`;
  const r = await engine.query<{ id: string; document_id: string; score: number | string }>(sql, params);
  return r.rows.map((row) => ({ id: row.id, documentId: row.document_id, score: Number(row.score) }));
}
