/**
 * Entity anchor -- an opt-in RRF list for "what is <entity> doing now" queries.
 *
 * Keyword and vector ranking treat every note that shares a question's words
 * alike, so once notes about one person or company pile up, the newest can fall
 * outside the window. When a query asks for the present state of something
 * ("now", "currently", "latest", ...) and names exactly one entity page, this
 * list reads pages by their relation to that entity instead: the entity page
 * first, then up to {@link ENTITY_ANCHOR_MAX} pages that link to it, newest
 * first. Fused as one more list beside the title and relational arms.
 *
 * Fusion, not a pin: the anchored pages enter RRF at the title arm's weight
 * instead of being placed above the organic rows, so a page the other arms
 * also found rises and one only this list found competes like a single-arm
 * hit. That softer reorder is the intent: the anchor should lift the newest
 * linked notes into the window, not decide the head on its own. Only linking
 * pages are anchored; a note that names the entity without a link is left to
 * the other arms, since finding it would mean a text scan of every page.
 *
 * Off by default (MEMRAIN_ENTITY_ANCHOR=1): it reorders the head of a result
 * list. When on it joins the query-cache ranking signature, so a cached
 * ordering from either setting is never served to the other.
 *
 * Read safety: the entity and every linked page must be readable by the caller
 * (source scope, soft delete, held or quarantined page and truth mirrors, and
 * for a remote caller diary/journal pages and owner-only lineage); the link
 * must be stored in a readable source with both ends live; the head chunk
 * comes from a visible mirror document. Deterministic, no model call,
 * fail-open (any error drops the list).
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
import { eligiblePageSql } from "../bounded-read.ts";
import { liveEdgeSql } from "../links.ts";
import { linkDiarySql } from "../links-privacy.ts";
import { pageRowFilterClauses, type PageFilters } from "./filters.ts";
import { identifierCandidates, isNameLikeIdentifier } from "./title-arm.ts";

/** Linked pages read per entity (the entity page itself is extra). */
export const ENTITY_ANCHOR_MAX = 10;
/** RRF weight of the list: on par with the title arm. */
export const ENTITY_ANCHOR_WEIGHT = 1.0;

const ENTITY_TYPES = ["person", "company", "organization", "project"];

/** Default OFF; `MEMRAIN_ENTITY_ANCHOR=1` turns the list on. */
export function entityAnchorEnabled(raw: string | undefined = process.env["MEMRAIN_ENTITY_ANCHOR"]): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Asks for the present state of something: "now", "currently", "latest", "these days" and similar. */
const CURRENT_STATE_CUE = /\b(?:now|nowadays|currently|current|latest|most recent(?:ly)?|newest|today|these days|at the moment|at present|presently|still|anymore|any more)\b/i;

export function asksForCurrentState(query: string): boolean {
  return query.length <= 512 && CURRENT_STATE_CUE.test(query);
}

export interface EntityAnchorOptions {
  sourceIds?: readonly string[];
  /** Page filters apply to the anchored pages (types, slug prefix, trust floor). */
  filters?: PageFilters;
  /** Non-operator caller: diary/journal pages and owner-only lineage are fenced. */
  remote?: boolean;
  onError?: (error: unknown) => void;
}

const identSql = (expr: string) => `btrim(regexp_replace(lower(${expr}), '[^[:alnum:]]+', ' ', 'g'))`;

function containsRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

/**
 * The one entity page the query names (whole title or slug leaf as a token run
 * of the query), readable by the caller. A name inside a longer matched name is
 * the same mention ("acme" inside "acme labs"); two different entities, or
 * none, give null.
 */
export async function namedEntity(engine: Engine, query: string, opts: EntityAnchorOptions = {}): Promise<string | null> {
  const candidates = identifierCandidates(query).filter(isNameLikeIdentifier);
  if (candidates.length === 0) return null;
  const params: unknown[] = [candidates, ENTITY_TYPES];
  const scope = andSourceScope("p.source_id", opts.sourceIds, params);
  const rows = (await engine.query<{ slug: string; ident_title: string; ident_leaf: string }>(
    `SELECT p.slug, ${identSql("COALESCE(p.title, '')")} AS ident_title, ${identSql("regexp_replace(p.slug, '^.*/', '')")} AS ident_leaf
       FROM pages p
      WHERE lower(btrim(COALESCE(p.type, ''))) = ANY($2::text[])
        AND (${identSql("COALESCE(p.title, '')")} = ANY($1::text[]) OR ${identSql("regexp_replace(p.slug, '^.*/', '')")} = ANY($1::text[]))
        AND ${eligiblePageSql("p", opts.remote === true)}${scope}
      ORDER BY p.slug COLLATE "C"
      LIMIT 50`,
    params,
  )).rows;
  const wanted = new Set(candidates);
  const matches = new Map<string, string[]>();
  for (const r of rows) {
    const idents = [r.ident_title, r.ident_leaf].filter(i => i && wanted.has(i));
    const best = idents.sort((a, b) => b.length - a.length)[0];
    if (best) matches.set(r.slug, best.split(" "));
  }
  const outer = [...matches].filter(([slug, m]) =>
    ![...matches].some(([other, o]) => other !== slug && o.length > m.length && containsRun(o, m)));
  return outer.length === 1 ? outer[0]![0] : null;
}

interface HeadRow { id: string; slug: string }

function headChunkSql(where: string, extraFrom = ""): string {
  return `SELECT DISTINCT ON (p.slug) c.id, p.slug, COALESCE(d.effective_date, p.updated_at) AS fresh
       FROM ${extraFrom}pages p
       JOIN documents d ON COALESCE(d.source_id, 'default') = p.source_id AND d.source_path = (${PAGE_MIRROR_PATH_SQL})
       JOIN chunks c ON c.document_id = d.id
      WHERE ${where} AND ${visibilityClause("d")}
      ORDER BY p.slug, c.id COLLATE "C" ASC`;
}

/**
 * Head chunk ids for an entity-scoped current-state query: the entity page,
 * then pages linking to it, newest first. Empty when the flag is off, the query
 * has no current-state cue, it names no single entity, or anything fails.
 */
export async function entityAnchorChunkIds(engine: Engine, query: string, opts: EntityAnchorOptions = {}): Promise<string[]> {
  if (!entityAnchorEnabled() || !asksForCurrentState(query)) return [];
  try {
    const entity = await namedEntity(engine, query, opts);
    if (!entity) return [];
    const remote = opts.remote === true;

    const own: unknown[] = [entity];
    const ownScope = andSourceScope("p.source_id", opts.sourceIds, own);
    const ownFilter = pageRowFilterClauses(own, opts.filters);
    const head = (await engine.query<HeadRow>(
      headChunkSql(`p.slug = $1 AND ${eligiblePageSql("p", remote)}${ownScope}${ownFilter}`), own,
    )).rows;

    const params: unknown[] = [entity];
    const linkScope = andSourceScope("l.source_id", opts.sourceIds, params);
    const diary = linkDiarySql("l", remote, params);
    const pageScope = andSourceScope("p.source_id", opts.sourceIds, params);
    const pageFilter = pageRowFilterClauses(params, opts.filters);
    // Newest first and capped in SQL, so a hub entity with thousands of
    // linking pages ships ENTITY_ANCHOR_MAX rows, not all of them.
    params.push(ENTITY_ANCHOR_MAX);
    const linked = (await engine.query<HeadRow>(
      `SELECT h.id, h.slug FROM (${headChunkSql(
        `l.target_slug = $1 AND p.slug = l.source_slug AND l.source_slug <> $1${linkScope}${diary}
          AND ${liveEdgeSql("l")} AND ${eligiblePageSql("p", remote)}${pageScope}${pageFilter}`,
        "links l, ",
      )}) h
       ORDER BY h.fresh DESC NULLS LAST, h.slug COLLATE "C" ASC
       LIMIT $${params.length}`,
      params,
    )).rows;
    return [...head, ...linked].map(r => r.id);
  } catch (error) {
    if (opts.onError) opts.onError(error);
    else console.error("[entity-anchor] dropping the list:", error instanceof Error ? error.message : error);
    return [];
  }
}
