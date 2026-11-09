/**
 * Slug resolution — turn a partial or informal string into the canonical
 * page slugs it most likely refers to, ranked best-first.
 *
 * Where `slug-canonicalize.ts` resolves ONE wikilink mention to a single
 * authoritative slug (a write-path concern, ambiguity → fall through), this
 * is the read-path counterpart: a remote caller hands us a fuzzy phrase
 * (`"alce smth"`, `"acme"`) and wants the matching pages back, scored. It
 * never arbitrates — it returns the candidate set and lets the caller pick.
 *
 * Matching is deterministic (no LLM): pg_trgm `similarity()` over both the
 * page title and the slug, taking the better of the two per page. We filter
 * on an explicit threshold (`similarity() >= t`) rather than the `%`
 * operator so no GIN trigram index is required — the function alone suffices
 * at this vault's scale (see migration 033, the same choice
 * `slug-canonicalize.ts` makes). An exact slug match always wins (score 1)
 * so an informal query that happens to be a real slug resolves to itself.
 *
 * Soft-deleted pages (`deleted_at IS NOT NULL`) are never candidates.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { normalizeAlias } from "./page-aliases.ts";
import { liveEdgeSql } from "./links.ts";
import { canMatchPersonName, nameVariantMatch, readPersonNames } from "./name-variants.ts";

/** One resolved candidate, ordered by descending `score` by the caller. */
export interface SlugResolution {
  slug: string;
  title: string | null;
  /** pg_trgm similarity in [0, 1]; 1 for an exact slug match. */
  score: number;
  variant?: true;
}

export interface ResolveSlugsOptions {
  exact?: boolean;
  excludeDiary?: boolean;
  /** Public body-redacted callers cannot confirm a private email field. */
  matchEmail?: boolean;
  /** Max candidates to return. Default 5; clamped to [1, 100]. */
  limit?: number;
  /** Minimum similarity to keep a fuzzy candidate. Default 0.3. */
  threshold?: number;
  /**
   * Tenant source scope (migration 047). When set, candidate pages are
   * filtered to `source_id = ANY(...)`; `[]` matches nothing. Omitted ->
   * unscoped (whole-brain).
   */
  sourceIds?: string[];
}

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.3;

function diaryFilter(alias: string, params: unknown[], exclude?: boolean): string {
  if (!exclude) return "";
  params.push(" \t\n\r\v\f\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF");
  return ` AND ${alias}.slug NOT LIKE 'life/diary/%' AND lower(btrim(${alias}.type, $${params.length})) NOT IN ('diary', 'journal')`;
}

export async function slugReferenceCounts(
  storage: Storage, slugs: string[], opts: Pick<ResolveSlugsOptions, "sourceIds" | "excludeDiary"> = {},
): Promise<Map<string, number>> {
  if (!slugs.length) return new Map();
  const params: unknown[] = [slugs];
  const scope = andSourceScope("l.source_id", opts.sourceIds, params);
  const diary = diaryFilter("p", params, opts.excludeDiary);
  const rows = await storage.engine().query<{ slug: string; n: number }>(
    `SELECT l.target_slug AS slug, count(DISTINCT l.source_slug)::int AS n FROM links l
      JOIN pages p ON p.slug = l.source_slug AND p.source_id = l.source_id AND p.deleted_at IS NULL
      WHERE l.target_slug = ANY($1::text[])${scope}${diary} AND ${liveEdgeSql("l")}
      GROUP BY l.target_slug`, params,
  );
  return new Map(rows.rows.map(r => [r.slug, Number(r.n)]));
}

/**
 * Resolve `query` to canonical page slugs, best-first.
 *
 * An exact (live) slug match short-circuits to a single score-1 result. The
 * fuzzy path returns up to `limit` pages whose title- or slug-similarity
 * clears `threshold`, ordered by score then slug for a stable tie-break.
 * Throws on an out-of-range `limit`/`threshold` so a typo fails loud rather
 * than silently returning the wrong slice.
 */
export async function resolveSlugs(
  storage: Storage,
  query: string,
  opts: ResolveSlugsOptions = {},
): Promise<SlugResolution[]> {
  const q = typeof query === "string" ? query.trim() : "";
  if (q === "") return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`resolveSlugs: limit must be in [1, 100] (got ${limit})`);
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `resolveSlugs: threshold must be in [0, 1] (got ${threshold})`,
    );
  }

  const db = storage.engine();

  if (opts.exact) {
    const params: unknown[] = [q, normalizeAlias(q), limit];
    const scope = andSourceScope("p.source_id", opts.sourceIds, params);
    const diary = diaryFilter("p", params, opts.excludeDiary);
    const email = opts.matchEmail === false ? "" : ` OR lower(btrim(p.compiled_truth->>'email')) = lower($1)
      OR lower(btrim(p.compiled_truth#>>'{identity,email}')) = lower($1)`;
    const rows = await db.query<{ slug: string; title: string | null }>(
      `SELECT p.slug, p.title FROM pages p WHERE p.deleted_at IS NULL${scope}${diary}
        AND (p.slug = $1 OR lower(btrim(p.title)) = lower($1)
          OR regexp_replace(p.slug, '^.*/', '') = lower($1)
          OR EXISTS (SELECT 1 FROM page_aliases pa WHERE pa.slug = p.slug AND pa.source_id = p.source_id AND pa.alias_norm = $2)
          ${email}) ORDER BY p.slug COLLATE "C" LIMIT $3`, params,
    );
    return rows.rows.map(r => ({ ...r, score: 1 }));
  }

  // Exact slug match wins outright — an informal query that IS a live slug
  // resolves to itself at full confidence, never diluted by a fuzzy runner-up.
  const exactParams: unknown[] = [q];
  const exactScope = andSourceScope("p.source_id", opts.sourceIds, exactParams);
  const exactDiary = diaryFilter("p", exactParams, opts.excludeDiary);
  const exact = await db.query<{ slug: string; title: string | null }>(
    `SELECT slug, title FROM pages p
      WHERE slug = $1 AND deleted_at IS NULL${exactScope}${exactDiary}
      LIMIT 1`,
    exactParams,
  );
  if (exact.rows.length > 0) {
    return [{ slug: exact.rows[0]!.slug, title: exact.rows[0]!.title, score: 1 }];
  }

  // Fuzzy: better of title- vs slug-similarity per page, threshold-gated.
  const fuzzyParams: unknown[] = [q, threshold, limit];
  const fuzzyScope = andSourceScope("p.source_id", opts.sourceIds, fuzzyParams);
  const fuzzyDiary = diaryFilter("p", fuzzyParams, opts.excludeDiary);
  const fuzzy = await db.query<{
    slug: string;
    title: string | null;
    score: number;
  }>(
    `SELECT slug, title,
            GREATEST(
              similarity(lower(COALESCE(title, '')), lower($1)),
              similarity(slug, lower($1))
            ) AS score
       FROM pages p
      WHERE deleted_at IS NULL${fuzzyScope}${fuzzyDiary}
        AND GREATEST(
              similarity(lower(COALESCE(title, '')), lower($1)),
              similarity(slug, lower($1))
            ) >= $2
      ORDER BY score DESC, slug ASC
      LIMIT $3`,
    fuzzyParams,
  );

  const hits: SlugResolution[] = fuzzy.rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    score: Number(r.score),
  }));
  if (canMatchPersonName(q)) {
    const { people } = await readPersonNames(db, opts.sourceIds);
    for (const p of people) {
      const match = nameVariantMatch(q, p.title);
      if (match && !hits.some(h => h.slug === p.slug)) {
        hits.push({ slug: p.slug, title: p.title, score: match === "strong" ? 0.9 : 0.5, variant: true });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).slice(0, limit);
}
