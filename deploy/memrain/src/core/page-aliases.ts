/**
 * Declared page aliases (migration 034).
 *
 * A page declares alternate names in `compiled_truth.aliases`; this module
 * normalizes them, keeps the `page_aliases` index in lockstep with each
 * page write, and resolves a free-text mention to a unique canonical slug.
 *
 * Aliases are FREE TEXT (a person's other name, a company's short name),
 * normalized as a phrase — lowercase / NFKC / whitespace-collapsed — NOT
 * slugified. The slug canonicalizer consults this as a high-confidence
 * stage (a declared alias is authoritative): ranked just below an exact
 * slug match and above the fuzzy tail/prefix/trigram cascade.
 *
 * EVENTUAL CONSISTENCY (by design, same model as the slug canonicalizer):
 * the alias index drives resolution at WIKILINK-WRITE time. Adding an alias
 * to `people/bob` does NOT retro-rewrite a `[[Robert]]` edge that some other
 * page already wrote to `robert`; that edge re-resolves on its own next
 * `syncWikilinksForPage` (i.e. when its source page is re-put). A migration
 * needs no backfill: declared aliases are a NEW convention introduced with
 * migration 034, so no pre-existing page carries one to index.
 */
import { pageRowFilterClauses } from "./search/filters.ts";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";

/** Upper bound on a single normalized alias, in CODE POINTS (defence vs
 *  unbounded writes). An over-limit alias is DROPPED, never truncated:
 *  truncating into the lookup key would collapse two distinct long names to
 *  the same key (and could split a surrogate pair at the cut). */
const MAX_ALIAS_LEN = 200;
/** Cap on aliases stored per page (a declaration list, not a corpus). */
const MAX_ALIASES_PER_PAGE = 64;

/**
 * Normalize a free-text alias to its index key: NFKC-fold, lowercase,
 * collapse internal whitespace, trim. Returns "" for a non-string or
 * all-whitespace input (the caller drops empties). NO truncation — length
 * is enforced by `isIndexableAlias` (drop, don't cut).
 */
export function normalizeAlias(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A normalized alias is usable as an index key iff non-empty and within the
 *  code-point length cap (counted by code point, not UTF-16 unit). */
export function isIndexableAlias(norm: string): boolean {
  if (!norm) return false;
  let count = 0;
  for (const _ of norm) {
    if (++count > MAX_ALIAS_LEN) return false;
  }
  return true;
}

/** True for a Postgres "undefined table" (42P01) error from either engine —
 *  the pre-migration-034 case the resolver tolerates. Everything else
 *  rethrows so a real DB fault is never silently masked. */
function isUndefinedTableError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  const msg = (e as { message?: string } | null)?.message ?? "";
  return /relation .*page_aliases.* does not exist/i.test(msg);
}

/**
 * Pull the distinct normalized aliases out of a page's compiled_truth.
 * Accepts `compiled_truth.aliases` as an array of strings; anything else
 * (missing, non-array, non-string entries) is skipped. Deduped, capped.
 */
export function extractAliasNorms(
  compiledTruth: Record<string, unknown> | null | undefined,
): string[] {
  const raw = compiledTruth?.["aliases"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const n = normalizeAlias(v);
    if (!isIndexableAlias(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_ALIASES_PER_PAGE) break;
  }
  return out;
}

/**
 * Replace the full alias set for one slug with `aliasNorms`. Runs on the
 * caller's transaction (the page write) so a page and its aliases commit
 * atomically. Empty `aliasNorms` just clears them. Idempotent against the
 * `(alias_norm, source_id, slug)` PK (migration 084).
 *
 * `sourceId` stamps the owning tenant on each row (defaults to 'default',
 * matching the page-write default). The per-slug DELETE is not source-filtered
 * on purpose: `slug` is the global pages PK today, so the page's alias set is
 * singular — and if the page's source ever changed, a source-filtered delete
 * would strand rows under the old tenant.
 */
export async function setPageAliases(
  engine: Engine,
  slug: string,
  aliasNorms: string[],
  sourceId: string = "default",
): Promise<void> {
  await engine.query(`DELETE FROM page_aliases WHERE slug = $1`, [slug]);
  for (const aliasNorm of aliasNorms) {
    await engine.query(
      `INSERT INTO page_aliases (alias_norm, source_id, slug) VALUES ($1, $2, $3)
       ON CONFLICT (alias_norm, source_id, slug) DO NOTHING`,
      [aliasNorm, sourceId, slug],
    );
  }
}

/**
 * Resolve a normalized alias to its UNIQUE live page slug. Returns null on a
 * miss, a COLLISION (two live pages claim the same alias), or when the sole
 * claimant IS `excludeSlug` (the mention's own source page) — the caller
 * falls through rather than arbitrating.
 *
 * Collision is detected GLOBALLY, before self-exclusion: if the source page
 * AND another page both claim the alias, that is a real two-page collision,
 * NOT a clean resolution to "the other one". So the query does NOT filter
 * `excludeSlug` in SQL; it pulls up to 2 live claimants and only resolves
 * when there is exactly one and it isn't the source.
 *
 * Pre-migration-034 brains (no `page_aliases` table) return null; any OTHER
 * DB error rethrows so a real fault never silently degrades to a wrong-slug
 * fuzzy match.
 */
export async function resolveAliasUnique(
  storage: Storage,
  aliasNorm: string,
  excludeSlug: string,
  sourceIds?: string[],
): Promise<string | null> {
  if (!isIndexableAlias(aliasNorm)) return null;
  try {
    const params: unknown[] = [aliasNorm];
    // Tenant scope (mig047/084): the alias row carries its own source_id, so
    // collision detection + resolution filter the index DIRECTLY — a sibling
    // tenant's declared alias can neither collide nor resolve. Omitted ->
    // unscoped (whole-brain).
    const scopeFilter = andSourceScope("pa.source_id", sourceIds, params);
    const r = await storage.engine().query<{ slug: string }>(
      `SELECT pa.slug AS slug
         FROM page_aliases pa
         JOIN pages p ON p.slug = pa.slug AND p.deleted_at IS NULL
        WHERE pa.alias_norm = $1${scopeFilter}
        LIMIT 2`,
      params,
    );
    if (r.rows.length !== 1) return null; // miss or collision
    const only = r.rows[0]!.slug;
    return only === excludeSlug ? null : only;
  } catch (e) {
    if (isUndefinedTableError(e)) return null; // pre-034 brain — degrade
    throw e; // a real DB fault must not silently mask as "no alias"
  }
}

/**
 * Resolve a normalized alias to ALL the live (source_id, slug) pages that
 * declare it — the multi-candidate form the alias-hop search stage needs. A
 * collision (two pages claim one alias) returns BOTH rows; the caller orders +
 * caps them deterministically. This is intentionally NOT `resolveAliasUnique`'s
 * collision-to-null posture: in search a collision should surface every
 * claimant up to a small cap, not nothing.
 *
 * Source-scoped (mig047): confined to `sourceIds`' pages when set, whole-brain
 * otherwise. Pre-migration-034 brains (no table) degrade to `[]`; any other DB
 * error rethrows so a real fault never masks as "no alias".
 */
export async function resolveAliasCandidates(
  storage: Storage,
  aliasNorm: string,
  sourceIds?: string[],
  filters?: import("./search/filters.ts").PageFilters,
): Promise<Array<{ slug: string; source_id: string }>> {
  if (!isIndexableAlias(aliasNorm)) return [];
  try {
    const params: unknown[] = [aliasNorm];
    // mig084: filter the alias index's own source_id (see resolveAliasUnique).
    const scopeFilter = andSourceScope("pa.source_id", sourceIds, params);
    // No LIMIT — return EVERY claimant of an exact alias, ordered. An
    // exact-alias match has few claimants, and
    // the caller (`applyAliasHop`) is what caps the injected set
    // (`MAX_ALIAS_INJECT`). A prior `LIMIT 8` truncated before that sort, so with
    // >8 claimants the deterministic top-N could be missed.
    const r = await storage.engine().query<{ slug: string; source_id: string }>(
      `SELECT pa.slug AS slug, pa.source_id AS source_id
         FROM page_aliases pa
         JOIN pages p ON p.slug = pa.slug
                     AND p.source_id = pa.source_id
                     AND p.deleted_at IS NULL
        WHERE pa.alias_norm = $1${scopeFilter}${pageRowFilterClauses(params, filters)}
        ORDER BY source_id, pa.slug`,
      params,
    );
    return r.rows;
  } catch (e) {
    if (isUndefinedTableError(e)) return [];
    throw e;
  }
}
