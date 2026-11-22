/**
 * Alias fan-out: when the query names an entity, also search under every
 * other name it goes by, so records filed under a nickname or under the
 * canonical name are not left for the agent to discover.
 *
 * "what did Bobby say about the budget" holds the alias `bobby` of
 * `people/robert-smith`, but every note says "Robert Smith"; "Robert Smith
 * budget" holds the title, but a note may say only "Bobby". The keyword arm
 * needs every word in one chunk and the vector arm has to get lucky, so either
 * way the note is missed.
 *
 * Resolution: the query's word n-grams (up to 4 tokens, longest first) are
 * looked up as a page title (a page that declares aliases; a page without any
 * has no other name to search) and in the alias index, a title match winning.
 * Only n-grams written as a name count (first and last word capitalized or
 * code-shaped), or a multi-word n-gram that resolves to exactly one page, so a
 * lowercase common word never fans out; a one-word n-gram must not be a
 * stopword. The n-gram must resolve to exactly one page the caller can read
 * (source grant, live page, a visible mirror document); a remote caller never
 * resolves a diary or journal page, or one derived from an owner-only source.
 * The first n-gram that resolves names the entity.
 *
 * Fan-out: the entity's declared aliases (longest first), then its title, less
 * the names the query already uses, capped at MEMRAIN_ALIAS_FANOUT_MAX
 * (default 4, 0..16; 0 or MEMRAIN_ALIAS_FANOUT=0 turns it off). Each name runs
 * as a keyword-only query that requires the name as a phrase and ranks by the
 * query's other content terms, FANOUT_ROWS_PER_ALIAS rows each, fused as one
 * more list; no embedding or model call. A returned hit only a fan-out list
 * found carries `matched_alias`, and the operator meta's `fanout` says what
 * was searched and skipped. Fail-open: any error yields no extra lists.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
import { ownerOnlyLineageSql } from "../owner-only.ts";
import { isIndexableAlias, normalizeAlias } from "../page-aliases.ts";
import { RELAXED_STOPWORDS } from "./keyword.ts";

export const DEFAULT_ALIAS_FANOUT_MAX = 4;
const ALIAS_FANOUT_LIMIT = 16;
/** Rows each name's list contributes. */
export const FANOUT_ROWS_PER_ALIAS = 5;
const MAX_GRAM = 4;
/** Words that never rank a fan-out search, on top of the keyword arm's own stopwords. */
const FANOUT_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "who", "what", "when", "where", "which", "with", "from", "that", "this", "are", "was", "were",
  "our", "your", "their", "does", "did", "has", "have", "how", "any", "all", "about", "into", "its", "is", "of", "to",
  "in", "on", "a", "an", "at", "by", "say", "said",
]);

/** Default ON; MEMRAIN_ALIAS_FANOUT=0 disables it. */
export function aliasFanoutEnabled(): boolean {
  return process.env["MEMRAIN_ALIAS_FANOUT"] !== "0" && aliasFanoutMax() > 0;
}

/** MEMRAIN_ALIAS_FANOUT_MAX: names searched per query, an integer 0..16; anything else is the default. */
export function aliasFanoutMax(raw: string | undefined = process.env["MEMRAIN_ALIAS_FANOUT_MAX"]): number {
  const v = (raw ?? "").trim();
  if (!/^\d+$/.test(v)) return DEFAULT_ALIAS_FANOUT_MAX;
  const n = Number(v);
  return n <= ALIAS_FANOUT_LIMIT ? n : DEFAULT_ALIAS_FANOUT_MAX;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function queryTokens(query: string): Token[] {
  const out: Token[] = [];
  for (const m of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}&'’.-]*/gu)) {
    const text = m[0].replace(/['’]s$/u, "").replace(/[.'’-]+$/u, "");
    if (text) out.push({ text, start: m.index!, end: m.index! + text.length });
  }
  return out;
}

/** Written as a name: an uppercase first letter or a digit. */
const nameShaped = (t: string): boolean => /^[\p{Lu}\p{N}]/u.test(t);

const words = (text: string): string[] => normalizeAlias(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

interface Gram {
  text: string;
  norm: string;
  from: number;
  to: number;
}

function grams(query: string, tokens: Token[]): Gram[] {
  const out: Gram[] = [];
  for (let n = Math.min(MAX_GRAM, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const text = query.slice(tokens[i]!.start, tokens[i + n - 1]!.end);
      const norm = normalizeAlias(text);
      if (!isIndexableAlias(norm)) continue;
      if (n === 1) {
        const t = tokens[i]!.text;
        if (t.length < 2 || RELAXED_STOPWORDS.has(norm) || FANOUT_STOPWORDS.has(norm)) continue;
      }
      out.push({ text, norm, from: i, to: i + n - 1 });
    }
  }
  return out;
}

/** A title as a name: the part after a "Kind: " prefix. */
function titleName(title: string): string {
  return (title.split(":").pop() ?? title).replace(/\s+/g, " ").trim();
}

export interface AliasFanoutName {
  /** The name searched, as the alias index or the title holds it. */
  alias: string;
  /** The entity page it belongs to. */
  page: string;
}

export interface AliasFanoutPlan {
  /** The page the query names. */
  entity: { slug: string; source_id: string };
  /** Names to search, in order. */
  names: AliasFanoutName[];
  /** Names past the cap. */
  skipped: string[];
  /** The query's other content terms, which rank each name's rows. */
  terms: string[];
}

/** `meta.fanout`: what the fan-out searched for this query (operator meta). */
export interface FanoutMeta {
  resolved_entity: string;
  aliases_searched: Array<{ alias: string; page: string; hits: number; truncated: boolean }>;
  aliases_skipped: string[];
  truncated: boolean;
}

/**
 * The entity `query` names and the other names to search it under, or null.
 * Two statements at most: the title and alias lookup over every n-gram, and,
 * once an entity resolves, its declared aliases. Page filters are not applied
 * here: the entity page need not match them, the rows its names find do (the
 * keyword arm applies them).
 */
export async function aliasFanoutPlan(
  engine: Engine,
  query: string,
  opts: { sourceIds?: readonly string[]; remote?: boolean; max?: number } = {},
): Promise<AliasFanoutPlan | null> {
  const max = opts.max ?? aliasFanoutMax();
  if (max <= 0) return null;
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;
  const candidates = grams(query, tokens);
  if (candidates.length === 0) return null;
  const params: unknown[] = [[...new Set(candidates.map((g) => g.norm))]];
  const aliasScope = andSourceScope("pa.source_id", opts.sourceIds, params);
  const titleScope = andSourceScope("p.source_id", opts.sourceIds, params);
  // Over `p`, the alias PAGE_MIRROR_PATH_SQL reads.
  const readable = (p: "p"): string => `${p}.deleted_at IS NULL${opts.remote
    ? ` AND ${p}.slug NOT LIKE 'life/diary/%' AND lower(btrim(COALESCE(${p}.type, ''))) NOT IN ('diary', 'journal')
        AND ${ownerOnlyLineageSql("page", `${p}.slug`)}`
    : ""}
        AND EXISTS (SELECT 1 FROM documents d
                     WHERE d.source_path = (${PAGE_MIRROR_PATH_SQL})
                       AND COALESCE(d.source_id, 'default') = ${p}.source_id AND ${visibilityClause("d")})`;
  const rows = (await engine.query<{ via: "title" | "alias"; norm: string; slug: string; source_id: string }>(
    `SELECT 'alias' AS via, pa.alias_norm AS norm, pa.slug, pa.source_id
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
      WHERE pa.alias_norm = ANY($1::text[])${aliasScope} AND ${readable("p")}
     UNION ALL
     SELECT 'title' AS via, lower(regexp_replace(btrim(p.title), '\\s+', ' ', 'g')) AS norm, p.slug, p.source_id
       FROM (SELECT DISTINCT slug, source_id FROM page_aliases) ta
       JOIN pages p ON p.slug = ta.slug AND p.source_id = ta.source_id
      WHERE lower(regexp_replace(btrim(p.title), '\\s+', ' ', 'g')) = ANY($1::text[])${titleScope}
        AND ${readable("p")}
      ORDER BY 1, 2, 4, 3`,
    params,
  )).rows;
  const claim = (via: "title" | "alias", norm: string): Array<{ slug: string; source_id: string }> => {
    const seen = new Set<string>();
    return rows.filter((r) => r.via === via && r.norm === norm).filter((r) => {
      const k = `${r.source_id}\u0000${r.slug}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  let resolved: { slug: string; source_id: string; from: number; to: number } | null = null;
  for (const g of candidates) {
    const titled = claim("title", g.norm);
    const pages = titled.length > 0 ? titled : claim("alias", g.norm);
    if (pages.length !== 1) continue;
    const gramTokens = tokens.slice(g.from, g.to + 1).map((t) => t.text);
    const asName = nameShaped(gramTokens[0]!) && nameShaped(gramTokens[gramTokens.length - 1]!);
    if (!asName && gramTokens.length < 2) continue;
    resolved = { ...pages[0]!, from: g.from, to: g.to };
    break;
  }
  if (!resolved) return null;

  const names = await entityNames(engine, resolved.slug, resolved.source_id);
  const queryWords = words(query);
  const inQuery = (name: string): boolean => {
    const w = words(name);
    return w.length > 0 && queryWords.some((_, i) => w.every((t, j) => queryWords[i + j] === t));
  };
  const seen = new Set<string>();
  const fresh = names.filter((n) => {
    const k = normalizeAlias(n);
    if (!k || seen.has(k) || inQuery(n)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length === 0) return null;
  const nameWords = new Set(fresh.flatMap(words));
  const terms = tokens
    .filter((_, i) => i < resolved.from || i > resolved.to)
    .map((t) => t.text)
    .filter((t) => {
      const l = t.toLowerCase();
      return t.length >= 2 && !FANOUT_STOPWORDS.has(l) && !RELAXED_STOPWORDS.has(l) && !nameWords.has(l);
    });
  return {
    entity: { slug: resolved.slug, source_id: resolved.source_id },
    names: fresh.slice(0, max).map((alias) => ({ alias, page: resolved.slug })),
    skipped: fresh.slice(max),
    terms,
  };
}

/** Every name of a page: its declared aliases, longest first, then its title. */
async function entityNames(engine: Engine, slug: string, sourceId: string): Promise<string[]> {
  const r = await engine.query<{ alias_norm: string; title: string | null }>(
    `SELECT pa.alias_norm, p.title
       FROM pages p LEFT JOIN page_aliases pa ON pa.slug = p.slug AND pa.source_id = p.source_id
      WHERE p.slug = $1 AND p.source_id = $2
      ORDER BY length(pa.alias_norm) DESC NULLS LAST, pa.alias_norm COLLATE "C"`,
    [slug, sourceId],
  );
  const aliases = r.rows.map((row) => row.alias_norm).filter((a): a is string => typeof a === "string" && a.length > 0);
  const title = r.rows[0]?.title ? titleName(r.rows[0].title) : "";
  return title ? [...aliases, title] : aliases;
}

/**
 * Hits a fan-out list found and no primary arm did, stamped with the name that
 * found them (the first list holding the chunk). Returns new objects for
 * stamped hits; the others are returned as they are.
 */
export function stampMatchedAlias<T extends { chunkId: string }>(
  hits: readonly T[],
  lists: ReadonlyArray<readonly string[]>,
  names: readonly AliasFanoutName[],
  armIds: ReadonlySet<string>,
): Array<T & { matched_alias?: string }> {
  const nameOf = new Map<string, string>();
  lists.forEach((list, i) => {
    for (const id of list) if (!nameOf.has(id) && names[i]) nameOf.set(id, names[i]!.alias);
  });
  return hits.map((h) => {
    const alias = nameOf.get(h.chunkId);
    return alias !== undefined && !armIds.has(h.chunkId) ? { ...h, matched_alias: alias } : h;
  });
}

/** The operator meta for a plan and the rows each name's list returned. */
export function fanoutMeta(plan: AliasFanoutPlan, lists: ReadonlyArray<readonly string[]>): FanoutMeta {
  return {
    resolved_entity: plan.entity.slug,
    aliases_searched: plan.names.map((n, i) => ({
      alias: n.alias,
      page: n.page,
      hits: lists[i]?.length ?? 0,
      truncated: (lists[i]?.length ?? 0) >= FANOUT_ROWS_PER_ALIAS,
    })),
    aliases_skipped: plan.skipped,
    truncated: plan.skipped.length > 0,
  };
}
