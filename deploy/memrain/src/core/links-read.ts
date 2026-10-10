/**
 * Links — read-side helpers over the migration 016 `links` table.
 *
 * Two deterministic, LLM-free reads that complement the write path in
 * `links.ts` (addLink / removeLink) and the traversal reads there
 * (graphNeighbors / graphQuery / traverseGraph):
 *
 *   - `getLinks(slug)` — every typed edge touching `slug`, grouped by
 *     type, split into `outbound` (slug is the source) and `inbound`
 *     (slug is the target). The page-centric "what relationships does
 *     this slug have?" view.
 *   - `listLinkSources()` — the KNOWN_LINK_TYPES catalogue annotated
 *     with the live edge count per type, so an agent can discover which
 *     relationship types the brain actually carries before querying.
 *
 * Both reuse the boundary validators + the type catalogue from `links.ts`
 * rather than redefining them.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { validateSlug, KNOWN_LINK_TYPES, liveEdgeSql, type LinkRow } from "./links.ts";

/** One typed-edge bucket for a slug — same type, one direction. */
export interface LinkGroup {
  type: string;
  direction: "outbound" | "inbound";
  /** Edges of this (type, direction), newest-first. */
  links: LinkRow[];
}

export interface GetLinksOptions {
  /** Max edges scanned per direction (1..1000). Default 1000. */
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, edges are filtered
   * to `source_id = ANY(...)`. Omitted -> unscoped (whole-brain); `[]` -> nothing.
   */
  sourceIds?: string[];
}

function normaliseLimit(limit: number | undefined): number {
  return typeof limit === "number" && limit >= 1 && limit <= 1000
    ? Math.floor(limit)
    : 1000;
}

/**
 * All typed edges touching `slug`, grouped by (type, direction). An
 * `outbound` group holds edges where `slug` is the source; `inbound`
 * where it is the target. Groups are ordered by type ASC then direction
 * (outbound before inbound); edges within a group are newest-first.
 */
export async function getLinks(
  storage: Storage,
  slug: string,
  opts: GetLinksOptions = {},
): Promise<LinkGroup[]> {
  validateSlug(slug);
  const limit = normaliseLimit(opts.limit);
  const params: unknown[] = [slug, limit];
  // Tenant scope (mig047): same filter string in both UNION arms.
  const scopeFilter = andSourceScope("source_id", opts.sourceIds, params);
  const r = await storage.engine().query<
    LinkRow & { direction: "outbound" | "inbound" }
  >(
    `(SELECT id, source_slug, target_slug, type, inferred_confidence,
             source_chunk_id, written_at::text AS written_at,
             'outbound' AS direction
        FROM links
       WHERE source_slug = $1${scopeFilter}
         AND ${liveEdgeSql("links")}
       ORDER BY written_at DESC
       LIMIT $2)
     UNION ALL
     (SELECT id, source_slug, target_slug, type, inferred_confidence,
             source_chunk_id, written_at::text AS written_at,
             'inbound' AS direction
        FROM links
       WHERE target_slug = $1${scopeFilter}
         AND ${liveEdgeSql("links")}
       ORDER BY written_at DESC
       LIMIT $2)`,
    params,
  );

  const groups = new Map<string, LinkGroup>();
  for (const row of r.rows) {
    const key = `${row.type}${row.direction}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: row.type, direction: row.direction, links: [] };
      groups.set(key, group);
    }
    const { direction: _direction, ...link } = row;
    group.links.push(link);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      // outbound before inbound
      a.direction.localeCompare(b.direction),
  );
}

/** A known link type annotated with its live edge count. */
export interface LinkSource {
  type: string;
  /** Number of edges of this type in the brain. */
  count: number;
  /** True for the KNOWN_LINK_TYPES catalogue; false for ad-hoc types. */
  known: boolean;
}

/**
 * The link-type catalogue with live per-type edge counts. Every entry of
 * KNOWN_LINK_TYPES is returned (count 0 when unused), plus any ad-hoc
 * type that exists in the table but is not in the catalogue. Ordered by
 * count DESC then type ASC, so the most-used relationship types surface
 * first while the full vocabulary stays discoverable.
 */
export async function listLinkSources(
  storage: Storage,
  sourceIds?: string[],
): Promise<LinkSource[]> {
  const params: unknown[] = [];
  let scopeFilter = "";
  // Tenant scope (mig047): count only edges in the given sources when set;
  // `[]` matches no row.
  if (sourceIds !== undefined) {
    params.push(sourceIds);
    scopeFilter = ` WHERE source_id = ANY($${params.length}::text[])`;
  }
  const r = await storage.engine().query<{ type: string; count: number }>(
    `SELECT type, COUNT(*)::int AS count
       FROM links${scopeFilter}
      GROUP BY type`,
    params,
  );

  const counts = new Map<string, number>();
  for (const row of r.rows) counts.set(row.type, Number(row.count));

  const out: LinkSource[] = [];
  const known = new Set<string>(KNOWN_LINK_TYPES);
  for (const type of KNOWN_LINK_TYPES) {
    out.push({ type, count: counts.get(type) ?? 0, known: true });
  }
  for (const [type, count] of counts) {
    if (!known.has(type)) out.push({ type, count, known: false });
  }
  return out.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
