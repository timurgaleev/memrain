/**
 * Identifier arm — retrieve the pages a query NAMES.
 *
 * The disease it cures: neither retrieval arm can see a document's identity.
 * The keyword arm ranks `chunks.search_vector` (chunk body + code symbol
 * columns, migration 030) and the vector arm ranks chunk embeddings — so
 * `documents.title` and `documents.source_path` are display-only columns on the
 * read path. A page whose distinguishing proper noun lives in its title/slug but
 * not in its body prose ("projects/<name>", a stub whose body says "die
 * Plattform") therefore never enters the candidate set at all. The title boost
 * (title-match.ts) and the exact-slug boost (intent-weights.ts) both run
 * POST-fusion, so they can only reorder candidates that already fused in: for
 * this shape they are boosts with nothing to boost.
 *
 * This arm closes that recall gap without touching the index: it matches the
 * query against each document's IDENTIFIER text — its title and its slug leaf
 * (the last path segment, scheme- and extension-stripped) — and contributes the
 * matching page's HEAD chunk as an extra RRF list, the same representative
 * chunk the relational arm and alias-hop use. The post-fusion title/exact
 * boosts then act on a candidate that finally exists.
 *
 * Matching direction is IDENTIFIER-INSIDE-QUERY, the complement of
 * `isTitlePhraseMatch` (query-inside-title): a page is named by "what is the
 * status of <name>" exactly when its whole normalized identifier appears as a
 * contiguous token run in the query. Requiring the WHOLE identifier is what
 * keeps this precise — a page named "Notes" is reached only by a query that
 * literally contains that word, never by term overlap.
 *
 * Deterministic, zero-LLM, fail-open: any error drops the arm rather than
 * breaking search.
 */
import { pageFilterClauses } from "./filters.ts";
import type { Engine } from "../engine/interface.ts";
import { visibilityClause } from "../visibility.ts";
import { tokenizeTitle } from "./title-match.ts";
import { buildHardExcludeClauseSql, normalizedPathSql } from "./curation.ts";
import { andSourceScope } from "../source-scope.ts";

/**
 * RRF weight for the identifier arm — parity with the keyword arm's `topic`
 * weight. It cannot be tuned DOWN as a "gentle nudge": hybrid.ts cuts the fused
 * list at the fanout before hydrating, so a de-weighted single-element list
 * scores below every other arm's tail and is sliced away entirely — the arm
 * would silently stop existing on exactly the noisy corpora it is for. At
 * parity a named page enters at roughly a single-arm rank-1 hit's strength, so
 * anything the vector AND keyword arms both surfaced still outranks it, and the
 * post-fusion title / exact-slug boosts decide the head from there.
 */
export const TITLE_ARM_WEIGHT = 1.0;

/**
 * Identifiers longer than this are prose, not names — a page titled with a
 * whole sentence is not something a query "names". Caps the n-gram set the
 * prefilter builds (queryTokens × this).
 */
const MAX_IDENTIFIER_TOKENS = 8;

/**
 * A SINGLE-token identifier must be at least this long to be treated as a name.
 * Without the floor a page whose slug leaf is `x` would be pulled in by any
 * query containing that letter. Three chars keeps real short names ("n8n",
 * "ci") — the cost is that a two-letter page is not reachable by name.
 */
const MIN_SINGLE_TOKEN_CHARS = 3;

/** Default ON; `MEMRAIN_TITLE_ARM=0` disables (mirrors the backlink-boost knob). */
export function titleArmEnabled(
  raw: string | undefined = process.env["MEMRAIN_TITLE_ARM"],
): boolean {
  return raw !== "0";
}

export interface TitleArmOptions {
  filters?: import("./filters.ts").PageFilters;
  onError?: (error: unknown) => void;
  /** Tenant scope — only documents of these sources are eligible. */
  sourceIds?: readonly string[];
  /** Max chunk ids returned. Default 20. */
  limit?: number;
}

/**
 * SQL for the identifier normal form: lowercase, non-alphanumerics collapsed to
 * single spaces, trimmed — the shape `tokenizeTitle(...).join(" ")` produces, so
 * a document's identifier and a query n-gram meet in one normal form.
 */
function normalizeIdentifierSql(expr: string): string {
  return `btrim(regexp_replace(lower(${expr}), '[^[:alnum:]]+', ' ', 'g'))`;
}

/**
 * True when an identifier is specific enough to act as a name — a multi-token
 * identifier always is; a single token must clear {@link MIN_SINGLE_TOKEN_CHARS}.
 */
export function isNameLikeIdentifier(identifier: string): boolean {
  const tokens = identifier.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.length > 1) return true;
  return tokens[0]!.length >= MIN_SINGLE_TOKEN_CHARS;
}

/**
 * Every contiguous token run of the query, up to {@link MAX_IDENTIFIER_TOKENS},
 * in the identifier normal form. These are the identifiers the query could be
 * naming; the SQL prefilter matches documents against this set.
 */
export function identifierCandidates(query: string): string[] {
  const tokens = tokenizeTitle(query);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= MAX_IDENTIFIER_TOKENS && i + n <= tokens.length; n++) {
      out.add(tokens.slice(i, i + n).join(" "));
    }
  }
  return [...out];
}

interface IdentifierRow {
  document_id: string;
  source_path: string;
  ident_title: string | null;
  ident_leaf: string | null;
}

/**
 * Chunk ids for the pages this query names, ranked most-specific-identifier
 * first (a longer name is a stronger claim), then by source path for a stable
 * order. Empty for a query that names nothing — the common case, and a pure
 * no-op on the fused result.
 */
export async function titleArmChunkIds(
  engine: Engine,
  query: string,
  opts: TitleArmOptions = {},
): Promise<string[]> {
  const candidates = identifierCandidates(query).filter(isNameLikeIdentifier);
  if (candidates.length === 0) return [];
  const limit = opts.limit ?? 20;

  try {
    // Step 1: the narrow scan — `documents` only (no chunk join), so the
    // un-indexable expression match never drags the chunk table through it.
    const params: unknown[] = [candidates];
    const scopeFilter = andSourceScope("d.source_id", opts.sourceIds, params);
    const pageFilter = pageFilterClauses(params, opts.filters);
    // Slug leaf: scheme-stripped path → last segment → extension dropped.
    const leafExpr = `regexp_replace(regexp_replace(${normalizedPathSql("d.source_path")}, '^.*/', ''), '\\.(md|markdown)$', '')`;
    const titleIdent = normalizeIdentifierSql("COALESCE(d.title, '')");
    const leafIdent = normalizeIdentifierSql(leafExpr);
    const docs = await engine.query<IdentifierRow>(
      `SELECT d.id AS document_id, d.source_path,
              ${titleIdent} AS ident_title,
              ${leafIdent}  AS ident_leaf
         FROM documents d
        WHERE (${titleIdent} = ANY($1::text[]) OR ${leafIdent} = ANY($1::text[]))
          AND ${visibilityClause("d")}${scopeFilter}${pageFilter}${buildHardExcludeClauseSql("d.source_path")}`,
      params,
    );
    if (docs.rows.length === 0) return [];

    // Re-decide in TS on the SAME normal form the candidates were built in, so
    // the arm's contract lives here and not in the engine's regexp dialect. The
    // name-like floor is NOT re-applied: `candidates` is already filtered, so
    // membership in it implies it (a second check here would be unreachable).
    const matched = new Set(candidates);
    const ranked: { documentId: string; sourcePath: string; specificity: number }[] = [];
    for (const row of docs.rows) {
      let best = 0;
      for (const ident of [row.ident_title, row.ident_leaf]) {
        if (!ident || !matched.has(ident)) continue;
        best = Math.max(best, ident.split(" ").filter(Boolean).length);
      }
      if (best > 0) {
        ranked.push({ documentId: row.document_id, sourcePath: row.source_path, specificity: best });
      }
    }
    if (ranked.length === 0) return [];
    ranked.sort((a, b) =>
      b.specificity - a.specificity || (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0),
    );
    const docIds = ranked.slice(0, limit).map((r) => r.documentId);

    // Step 2: the head chunk (lowest id) per matched document — the same
    // representative chunk alias-hop and the relational arm inject.
    const heads = await engine.query<{ document_id: string; id: string }>(
      `SELECT DISTINCT ON (c.document_id) c.document_id, c.id
         FROM chunks c
        WHERE c.document_id = ANY($1::text[])
        ORDER BY c.document_id, c.id COLLATE "C" ASC`,
      [docIds],
    );
    const headByDoc = new Map(heads.rows.map((r) => [r.document_id, r.id]));
    const out: string[] = [];
    for (const id of docIds) {
      const head = headByDoc.get(id);
      // A chunkless document (metadata-only page) simply has nothing to fuse.
      if (head) out.push(head);
    }
    return out;
  } catch (err) {
    opts.onError?.(err);
    // Fail-open: the arm is additive recall, never a dependency of search.
    console.error(
      "[title-arm] identifier lookup failed, dropping arm:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
