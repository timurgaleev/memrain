/**
 * Slug redirects (migration 067).
 *
 * A durable `old-slug → canonical-slug` forwarding record, left behind when a
 * page is RENAMED or MERGED (see `renamePage` in pages.ts). It lets a stale
 * `[[old-slug]]` wikilink and a direct `page_get old-slug` still land on the
 * live page instead of 404-ing or minting a dangling target.
 *
 * DISTINCT from `page_aliases` (migration 034): that table maps a normalized
 * free-text NAME → slug and feeds the wikilink canonicalizer's declared-alias
 * stage. This table maps an OLD SLUG → the canonical slug. See the migration
 * header for the full contrast.
 *
 * Source-scoped (migration 047 tenant axis): a redirect resolves ONLY against
 * the caller's own source(s), so a rename under one tenant never forwards
 * another tenant's slug. A single hop only — chains are collapsed at write time
 * by `renamePage`, not followed transitively here.
 */
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";

/** True for a Postgres "undefined table" (42P01) — the pre-migration-067 case
 *  the resolver tolerates so an old brain degrades to "no redirect" rather than
 *  crashing. Everything else rethrows so a real DB fault is never masked. */
function isUndefinedTableError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  const msg = (e as { message?: string } | null)?.message ?? "";
  return /relation .*slug_aliases.* does not exist/i.test(msg);
}

/**
 * Resolve `slug` through the redirect registry to its canonical slug. Returns
 * the input slug UNCHANGED on a miss (no redirect), a redirect whose target is
 * missing or soft-deleted, a self/loop guard, an empty scope, or a pre-067
 * brain. A single hop only.
 *
 * `sourceIds` scopes the lookup (mig047): a redirect resolves only when it is
 * owned by one of these sources, ordered by the caller's source preference so a
 * multi-tenant hit is deterministic. Omitted → whole-brain (local/CLI); `[]` →
 * no alias resolves.
 */
export async function resolveSlugWithAlias(
  storage: Storage,
  slug: string,
  sourceIds?: readonly string[],
): Promise<string> {
  if (typeof slug !== "string" || slug.length === 0) return slug;
  try {
    const params: unknown[] = [slug];
    let scope = "";
    let order = "a.id";
    if (sourceIds !== undefined) {
      params.push([...sourceIds]);
      scope = ` AND a.source_id = ANY($${params.length}::text[])`;
      // Prefer the caller's earlier-listed sources on a cross-tenant collision.
      order = `array_position($${params.length}::text[], a.source_id), a.id`;
    }
    const r = await storage.engine().query<{ canonical_slug: string }>(
      `SELECT a.canonical_slug
         FROM slug_aliases a
         JOIN pages p ON p.slug = a.canonical_slug AND p.deleted_at IS NULL
        WHERE a.alias_slug = $1${scope}
        ORDER BY ${order}
        LIMIT 1`,
      params,
    );
    return r.rows[0]?.canonical_slug ?? slug;
  } catch (e) {
    if (isUndefinedTableError(e)) return slug; // pre-067 brain — degrade
    throw e;
  }
}

export interface SetSlugAliasInput {
  alias_slug: string;
  canonical_slug: string;
  /** Owning source (tenant). Defaults to 'default'. */
  source_id?: string;
  notes?: string;
}

/**
 * Upsert a redirect. Runs on the caller's transaction/engine so a rename and
 * its redirect commit atomically. Idempotent against the (source_id,
 * alias_slug) unique key — re-pointing an existing redirect overwrites its
 * canonical target. A self-redirect (alias == canonical) is refused by the
 * CHECK constraint; the caller should not attempt one.
 *
 * Before writing, any EXISTING redirects that pointed AT `alias_slug` are
 * re-pointed to `canonical_slug` (chain collapse): if `a→b` exists and we now
 * record `b→c`, `a` is updated to `a→c` so a single hop always suffices. A row
 * that would collapse to a self-redirect (its own alias equals the new
 * canonical) is deleted instead of updated.
 */
export async function setSlugAlias(
  engine: Engine,
  input: SetSlugAliasInput,
): Promise<void> {
  const source = input.source_id ?? "default";
  const alias = input.alias_slug;
  const canonical = input.canonical_slug;
  if (alias === canonical) {
    throw new Error("setSlugAlias: alias_slug and canonical_slug must differ");
  }
  // Collapse chains: redirects that forwarded to `alias` now forward to
  // `canonical`. Drop any that would become a self-redirect.
  await engine.query(
    `DELETE FROM slug_aliases
       WHERE source_id = $1 AND canonical_slug = $2 AND alias_slug = $3`,
    [source, alias, canonical],
  );
  await engine.query(
    `UPDATE slug_aliases
        SET canonical_slug = $3
      WHERE source_id = $1 AND canonical_slug = $2`,
    [source, alias, canonical],
  );
  await engine.query(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, alias_slug)
       DO UPDATE SET canonical_slug = EXCLUDED.canonical_slug,
                     notes = EXCLUDED.notes`,
    [source, alias, canonical, input.notes ?? null],
  );
}
