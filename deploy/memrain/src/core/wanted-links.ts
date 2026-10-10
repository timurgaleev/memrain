/**
 * Wanted pages: authored links whose target page does not exist yet
 * (migration 136).
 *
 * The wikilink scanner records each reference it could not resolve — a
 * dangling `[[name]]`, kept as an `unqualified` edge onto its slugified
 * target, and a `[Name](path)` link, which makes no edge at all — replacing a
 * page's rows together with its wikilink edges. A page write that creates the
 * target, brings it back, or declares it as an alias reconnects the rows in
 * the write's own transaction, under its slug lock: the linking page gets a
 * `qualified` edge to the new page, the placeholder edge goes, and the row is
 * deleted. Rows are derived state; the page text is the source of truth, and
 * re-extracting a page rebuilds them.
 */
import type { Engine } from "./engine/interface.ts";
import { slugifyTarget, validateSlug, liveEndpointSql, escapeLike } from "./links.ts";
import { lockPageSlugs } from "./pages.ts";
import { normalizeAlias } from "./page-aliases.ts";
import { andSourceScope } from "./source-scope.ts";

const MAX_SURFACE_LEN = 512;
/** Below this a basename is too short to claim a dangling reference. */
const MIN_TAIL_LEN = 2;

function isSlug(s: string): boolean {
  try {
    validateSlug(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace one page's wanted rows with `wanted` (target slug -> surface) inside
 * the caller's transaction. A row already recorded keeps its `first_seen`.
 * `scope` null is the unscoped writer: its rows carry the `default` source,
 * like the edges it writes, and its delete is not confined to one source.
 */
export async function replaceWantedLinks(
  tx: Engine,
  fromSlug: string,
  scope: string | null,
  wanted: ReadonlyMap<string, string>,
): Promise<void> {
  const targets: string[] = [];
  const surfaces: string[] = [];
  for (const [target, surface] of wanted) {
    if (!isSlug(target)) continue;
    targets.push(target);
    surfaces.push(surface.slice(0, MAX_SURFACE_LEN));
  }
  const delParams: unknown[] = [fromSlug, targets];
  let delScope = "";
  if (scope !== null) {
    delParams.push(scope);
    delScope = ` AND source_id = $3`;
  }
  await tx.query(
    `DELETE FROM wanted_links
      WHERE from_slug = $1 AND NOT (target_slug = ANY($2::text[]))${delScope}`,
    delParams,
  );
  if (targets.length === 0) return;
  await tx.query(
    `INSERT INTO wanted_links (source_id, from_slug, target_slug, surface)
     SELECT $1, $2, t.slug, t.surface
       FROM unnest($3::text[], $4::text[]) AS t(slug, surface)
     ON CONFLICT (source_id, from_slug, target_slug) DO NOTHING`,
    [scope ?? "default", fromSlug, targets, surfaces],
  );
}

interface WantedRow {
  from_slug: string;
  target_slug: string;
  surface: string;
}

/**
 * A live page now answers at `slug` in `sourceId`: give every reference that
 * was waiting for it its edge. Runs in the page write's transaction. A
 * reference matches the way the wikilink resolver would have matched it —
 * the exact slug, the page's basename when no other live page in the source
 * shares it, or a declared alias only this page carries — so a reconnect
 * never picks a page the resolver would have called ambiguous. Edges already
 * pointing at the slug unresolved are marked resolved too. Returns how many
 * references were reconnected.
 */
export async function reconnectWantedLinks(
  tx: Engine,
  slug: string,
  sourceId: string,
  aliasNorms: readonly string[] = [],
): Promise<number> {
  const tail = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : null;
  const aliasBySlug = new Map<string, string>();
  for (const norm of aliasNorms) {
    const t = slugifyTarget(norm);
    if (t !== "unknown" && t !== slug && !aliasBySlug.has(t)) aliasBySlug.set(t, norm);
  }
  const candidates = new Set<string>([slug, ...aliasBySlug.keys()]);
  if (tail !== null && tail.length >= MIN_TAIL_LEN) candidates.add(tail);

  // A soft-deleted linking page keeps its rows for when it comes back, but
  // gets no edge while it is gone.
  const found = await tx.query<WantedRow>(
    `SELECT w.from_slug, w.target_slug, w.surface
       FROM wanted_links w
       JOIN pages o ON o.slug = w.from_slug AND o.deleted_at IS NULL
      WHERE w.target_slug = ANY($1::text[]) AND w.source_id = $2`,
    [[...candidates], sourceId],
  );
  const rows = found.rows.filter((r) => r.target_slug === slug || r.target_slug === tail || aliasBySlug.has(r.target_slug));

  let tailUnique: boolean | null = null;
  const aliasUnique = new Map<string, boolean>();
  let reconnected = 0;
  for (const row of rows) {
    let matches = row.target_slug === slug;
    if (!matches && row.target_slug === tail) {
      tailUnique ??= await basenameIsUnique(tx, slug, tail, sourceId);
      matches = tailUnique;
    }
    const norm = aliasBySlug.get(row.target_slug);
    if (!matches && norm !== undefined && normalizeAlias(row.surface) === norm) {
      if (!aliasUnique.has(norm)) aliasUnique.set(norm, await aliasIsUnique(tx, slug, norm, sourceId));
      matches = aliasUnique.get(norm)!;
    }
    if (!matches) continue;
    if (row.from_slug !== slug) {
      await tx.query(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence, link_kind,
            resolution_type, link_source, source_id)
         VALUES ($1, $2, 'wikilink', 1.0, 'plain', 'qualified', 'markdown', $3)
         ON CONFLICT (source_slug, target_slug, type, source_id, link_source)
           DO UPDATE SET resolution_type = 'qualified'`,
        [row.from_slug, slug, sourceId],
      );
      if (row.target_slug !== slug) {
        await tx.query(
          `DELETE FROM links
            WHERE source_slug = $1 AND target_slug = $2 AND type = 'wikilink'
              AND link_source = 'markdown' AND resolution_type = 'unqualified'
              AND source_id = $3`,
          [row.from_slug, row.target_slug, sourceId],
        );
      }
      reconnected += 1;
    }
    await tx.query(
      `DELETE FROM wanted_links WHERE source_id = $1 AND from_slug = $2 AND target_slug = $3`,
      [sourceId, row.from_slug, row.target_slug],
    );
  }
  await tx.query(
    `UPDATE links SET resolution_type = 'qualified'
      WHERE target_slug = $1 AND type = 'wikilink' AND resolution_type = 'unqualified'
        AND source_id = $2`,
    [slug, sourceId],
  );
  return reconnected;
}

/**
 * Take the slug lock of every exact wanted target, first thing in the
 * writer's transaction: a creation of one of them still in flight finishes
 * before {@link reconnectAppearedTargets} looks. Taken before any row is
 * written, so the creator's reconnect never waits on this transaction's rows
 * while this one waits on its lock.
 */
export async function lockWantedTargets(tx: Engine, wanted: ReadonlyMap<string, string>): Promise<void> {
  await lockPageSlugs(tx, ...[...wanted.keys()].filter(isSlug));
}

/**
 * Reconnect the targets of rows `replaceWantedLinks` just wrote that a live
 * page answers by now. The writer resolved its links before its transaction,
 * so a page created in between ran its own reconnect before these rows
 * existed and found nothing to reconnect. An exact target is covered by
 * {@link lockWantedTargets}; a namespaced or aliased page committed before
 * this check is found by the query.
 */
export async function reconnectAppearedTargets(
  tx: Engine,
  sourceId: string,
  wanted: ReadonlyMap<string, string>,
): Promise<number> {
  const targets = [...wanted.keys()].filter(isSlug);
  if (targets.length === 0) return 0;
  const norms = [...new Set([...wanted.values()].map((v) => normalizeAlias(v)).filter((n) => n.length > 0))];
  const live = await tx.query<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.deleted_at IS NULL AND p.source_id = $2
        AND (p.slug = ANY($1::text[])
             OR regexp_replace(p.slug, '^.*/', '') = ANY($1::text[])
             OR EXISTS (SELECT 1 FROM page_aliases pa
                         WHERE pa.slug = p.slug AND pa.source_id = $2
                           AND pa.alias_norm = ANY($3::text[])))`,
    [targets, sourceId, norms],
  );
  let reconnected = 0;
  for (const { slug } of live.rows) {
    const aliases = await tx.query<{ alias_norm: string }>(
      `SELECT alias_norm FROM page_aliases WHERE slug = $1`,
      [slug],
    );
    reconnected += await reconnectWantedLinks(tx, slug, sourceId, aliases.rows.map((a) => a.alias_norm));
  }
  return reconnected;
}

/** No other live page in the source is named `tail`, flat or namespaced. */
async function basenameIsUnique(tx: Engine, slug: string, tail: string, sourceId: string): Promise<boolean> {
  const r = await tx.query<{ one: number }>(
    `SELECT 1 AS one FROM pages
      WHERE deleted_at IS NULL AND source_id = $3 AND slug <> $1
        AND (slug = $2 OR slug LIKE $4 ESCAPE '\\')
      LIMIT 1`,
    [slug, tail, sourceId, `%/${escapeLike(tail)}`],
  );
  return r.rows.length === 0;
}

/** `slug` is the only live page in the source declaring the alias. */
async function aliasIsUnique(tx: Engine, slug: string, norm: string, sourceId: string): Promise<boolean> {
  const r = await tx.query<{ slug: string }>(
    `SELECT DISTINCT pa.slug FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.deleted_at IS NULL
      WHERE pa.alias_norm = $1 AND pa.source_id = $2
      LIMIT 2`,
    [norm, sourceId],
  );
  return r.rows.length === 1 && r.rows[0]!.slug === slug;
}

export interface WantedPage {
  /** The slugified target no live page answers yet. */
  target_slug: string;
  /** Distinct live pages that link to it. */
  referenced_by: number;
  /** Up to three of them, by slug. */
  sample_from: string[];
  /** One way the target was written. */
  surface: string;
  first_seen: string;
}

export interface ListWantedPagesOptions {
  /** Tenant read scope. Omitted -> whole brain; `[]` -> nothing. */
  sourceIds?: string[];
  /** 1..200, default 50. */
  limit?: number;
}

/** Missing link targets, most-referenced first. Hidden linking pages never count. */
export async function listWantedPages(
  engine: Engine,
  opts: ListWantedPagesOptions = {},
): Promise<WantedPage[]> {
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 200 ? Math.floor(opts.limit) : 50;
  const params: unknown[] = [limit];
  const scope = andSourceScope("w.source_id", opts.sourceIds, params);
  const r = await engine.query<{
    target_slug: string;
    referenced_by: number;
    sample_from: string[];
    surface: string;
    first_seen: string;
  }>(
    `SELECT w.target_slug,
            COUNT(DISTINCT w.from_slug)::int AS referenced_by,
            (array_agg(DISTINCT w.from_slug ORDER BY w.from_slug))[1:3] AS sample_from,
            MIN(w.surface) AS surface,
            to_char(MIN(w.first_seen) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen
       FROM wanted_links w
       JOIN pages o ON o.slug = w.from_slug AND o.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM pages t
                         WHERE t.slug = w.target_slug AND t.deleted_at IS NULL
                           AND t.source_id = w.source_id)
        AND ${liveEndpointSql("w.from_slug")}${scope}
      GROUP BY w.target_slug
      ORDER BY referenced_by DESC, w.target_slug
      LIMIT $1`,
    params,
  );
  return r.rows.map((x) => ({
    target_slug: x.target_slug,
    referenced_by: Number(x.referenced_by),
    sample_from: x.sample_from ?? [],
    surface: x.surface,
    first_seen: x.first_seen,
  }));
}
