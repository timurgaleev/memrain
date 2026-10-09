/**
 * Backlinks — find what points at a given target.
 *
 *   - `wikilink` (the default "what links here" lookup) reads the page-scoped
 *     `links` table: the requested name is resolved to its canonical slug with
 *     the same resolver the wikilink write path uses (redirects, exact,
 *     declared alias, tail/prefix, trigram), and every live page with an edge
 *     to that slug is returned. Slugs keep non-Latin scripts, so a Cyrillic
 *     target resolves to its own page.
 *   - `tag` / `date` read the chunk-scoped entities + entity_mentions tables,
 *     matched on the exact `(type, name)` entity id.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { entityId, type EntityType } from "./entities.ts";
import { slugifyTarget } from "./links.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";
import { pageSourcePath } from "./page-index.ts";

export interface BacklinkHit {
  documentId: string;
  sourcePath: string;
  title: string | null;
  /**
   * `wikilink`: number of link edges (one per link type) from this page to the
   * target. `tag` / `date`: chunks in this document mentioning the entity.
   */
  mentionCount: number;
  /**
   * `wikilink`: the target slug the edge points at. `tag` / `date`: first-seen
   * surface form (helps disambiguate aliases like `[[Foo|F]]`).
   */
  surfaceForm: string;
}

export interface BacklinksOptions {
  /** Target type. Defaults to `wikilink` — the "what links here" lookup over page links. */
  type?: EntityType;
  /** Limit on rows returned. Default 50. */
  limit?: number;
  /**
   * Tenant source scope (migration 047). When set, the slug resolution, the
   * link edges and the linking pages (or, for `tag` / `date`, the documents)
   * are filtered to `source_id = ANY(...)`. Omitted -> unscoped; `[]` -> nothing.
   */
  sourceIds?: string[];
  /**
   * `wikilink` only: return nothing when the name resolves to, or slugifies
   * as, a target this predicate rejects. Checked against every target the
   * edges are matched on, so an alias cannot route around it.
   */
  excludeTarget?: (slug: string) => boolean;
}

export async function findBacklinks(
  storage: Storage,
  name: string,
  opts: BacklinksOptions = {},
): Promise<BacklinkHit[]> {
  const type = opts.type ?? "wikilink";
  const limit = opts.limit ?? 50;
  if (limit < 1 || limit > 1000) {
    throw new Error(`backlinks: limit must be in [1, 1000] (got ${limit})`);
  }
  if (type === "wikilink") {
    return findPageBacklinks(storage, name, limit, opts.sourceIds, opts.excludeTarget);
  }
  const eid = entityId(type, name);

  const params: unknown[] = [eid, limit];
  // Tenant scope (mig047): filter the joined documents (nullable source_id)
  // whenever a list is given; `[]` matches nothing.
  const scopeFilter = andSourceScope("d.source_id", opts.sourceIds, params);

  const db = storage.raw();
  const result = await db.query<{
    document_id: string;
    source_path: string;
    title: string | null;
    mention_count: number;
    surface_form: string;
  }>(
    `SELECT
       d.id           AS document_id,
       d.source_path  AS source_path,
       d.title        AS title,
       COUNT(*)::int  AS mention_count,
       MIN(em.surface_form) AS surface_form
     FROM entity_mentions em
     JOIN chunks c   ON c.id = em.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE em.entity_id = $1${scopeFilter}
     GROUP BY d.id, d.source_path, d.title
     ORDER BY mention_count DESC, d.title NULLS LAST, d.source_path
     LIMIT $2`,
    params,
  );

  return result.rows.map((r) => ({
    documentId: r.document_id,
    sourcePath: r.source_path,
    title: r.title,
    mentionCount: r.mention_count,
    surfaceForm: r.surface_form,
  }));
}

/**
 * Pages linking to `name`'s canonical slug, read from the `links` table. The
 * slugified name is queried alongside the resolved slug so an edge left on a
 * dangling (unresolved) target still counts.
 */
async function findPageBacklinks(
  storage: Storage,
  name: string,
  limit: number,
  sourceIds: string[] | undefined,
  excludeTarget: ((slug: string) => boolean) | undefined,
): Promise<BacklinkHit[]> {
  const trimmed = name.trim();
  const fallback = slugifyTarget(trimmed);
  if (fallback === "unknown") return [];
  const resolver = makeSlugResolver(
    storage,
    "",
    sourceIds !== undefined ? { sourceIds } : {},
  );
  const resolved = await resolver.resolve(trimmed);
  const targets = [...new Set([resolved.slug, fallback])];
  if (excludeTarget && targets.some(excludeTarget)) return [];

  const params: unknown[] = [targets, limit];
  const linkScope = andSourceScope("l.source_id", sourceIds, params);
  const pageScope = andSourceScope("p.source_id", sourceIds, params);
  const db = storage.engine();
  const result = await db.query<{
    slug: string;
    source_id: string | null;
    title: string | null;
    mention_count: number;
    target_slug: string;
  }>(
    `SELECT
       p.slug         AS slug,
       p.source_id    AS source_id,
       p.title        AS title,
       COUNT(*)::int  AS mention_count,
       MIN(l.target_slug) AS target_slug
     FROM links l
     JOIN pages p ON p.slug = l.source_slug AND p.deleted_at IS NULL
     WHERE l.target_slug = ANY($1::text[])${linkScope}${pageScope}
     GROUP BY p.slug, p.source_id, p.title
     ORDER BY mention_count DESC, p.title NULLS LAST, p.slug
     LIMIT $2`,
    params,
  );
  if (result.rows.length === 0) return [];

  // Report the page's mirror document id when it has one; the mirror path
  // itself stands in for a page that was never indexed.
  const paths = result.rows.map((r) => pageSourcePath(r.slug, r.source_id));
  const docParams: unknown[] = [paths];
  const docScope = andSourceScope("source_id", sourceIds, docParams);
  const docs = await db.query<{ id: string; source_path: string }>(
    `SELECT id, source_path FROM documents
      WHERE source_path = ANY($1::text[])${docScope}
      ORDER BY id`,
    docParams,
  );
  const docIdByPath = new Map<string, string>();
  for (const d of docs.rows) {
    if (!docIdByPath.has(d.source_path)) docIdByPath.set(d.source_path, d.id);
  }

  return result.rows.map((r, i) => ({
    documentId: docIdByPath.get(paths[i]!) ?? paths[i]!,
    sourcePath: paths[i]!,
    title: r.title,
    mentionCount: r.mention_count,
    surfaceForm: r.target_slug,
  }));
}
