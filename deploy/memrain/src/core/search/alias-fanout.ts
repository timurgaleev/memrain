/**
 * Alias fan-out: a name inside the query that a page declares as an alias
 * also searches under the page's own name.
 *
 * The alias hop (alias-hop.ts) acts only when the WHOLE query is an alias.
 * "what did Bobby say about the budget" holds the alias `bobby` of
 * `people/robert-smith`, but every note says "Robert Smith", so the keyword
 * arm (which needs every word) finds nothing and the vector arm has to get
 * lucky. Here each 1–4 word phrase of the query is looked up in the alias
 * index; a resolved phrase is replaced by the page's name and that query runs
 * through the keyword arm as one more fused list.
 *
 * Precision guards: longest phrases first, never overlapping; the phrase must
 * resolve to exactly one page the caller can read (source grant, live page, a
 * visible mirror document); a one-word phrase must be written capitalized or
 * code-shaped and not be a stopword; a page whose name the query already
 * uses is skipped; at most MAX_ALIAS_FANOUT names. A query that IS an alias
 * is left to the alias hop. Keyword only: no embedding or model call.
 * Fail-open: any error yields no extra lists.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
import { ownerOnlyLineageSql } from "../owner-only.ts";
import { isIndexableAlias, normalizeAlias } from "../page-aliases.ts";
import { RELAXED_STOPWORDS } from "./keyword.ts";

/** Names searched per query at most. */
export const MAX_ALIAS_FANOUT = 2;
const MAX_GRAM = 4;

/** Default ON; MEMRAIN_ALIAS_FANOUT=0 disables it. */
export function aliasFanoutEnabled(): boolean {
  return process.env["MEMRAIN_ALIAS_FANOUT"] !== "0";
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function queryTokens(query: string): Token[] {
  const out: Token[] = [];
  for (const m of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}&'\u2019.-]*/gu)) {
    const text = m[0].replace(/['\u2019]s$/u, "").replace(/[.'\u2019-]+$/u, "");
    if (text) out.push({ text, start: m.index!, end: m.index! + text.length });
  }
  return out;
}

/** Written as a name: an uppercase first letter or a digit. */
const nameShaped = (t: string): boolean => /^[\p{Lu}\p{N}]/u.test(t);

const words = (text: string): string[] => normalizeAlias(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export interface AliasFanout {
  /** The phrase as written in the query. */
  alias: string;
  slug: string;
  source_id: string;
  /** The query with the phrase replaced by the page's name. */
  query: string;
}

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
      if (n === tokens.length) continue; // the whole query: the alias hop's case
      const text = query.slice(tokens[i]!.start, tokens[i + n - 1]!.end);
      const norm = normalizeAlias(text);
      if (!isIndexableAlias(norm)) continue;
      if (n === 1) {
        const t = tokens[i]!.text;
        if (t.length < 2 || !nameShaped(t) || RELAXED_STOPWORDS.has(norm)) continue;
      }
      out.push({ text, norm, from: i, to: i + n - 1 });
    }
  }
  return out;
}

/** The page's name: its title, else its slug leaf with dashes as spaces. */
function pageName(title: string | null, slug: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t) return t;
  return (slug.split("/").pop() ?? slug).replace(/[-_]+/g, " ").trim();
}

/**
 * The alias phrases in `query` and the rewritten queries to search. One SQL
 * statement over the alias index; empty for a one-word query. Page filters
 * are not applied here: the alias page need not match them, the rows the
 * rewritten query finds do (the keyword arm applies them). A remote caller
 * never resolves through a diary or journal page, or a page derived from an
 * owner-only source, the pages the remote fact readers leave out too.
 */
export async function aliasFanoutQueries(
  engine: Engine,
  query: string,
  opts: { sourceIds?: readonly string[]; remote?: boolean } = {},
): Promise<AliasFanout[]> {
  const tokens = queryTokens(query);
  if (tokens.length < 2) return [];
  const candidates = grams(query, tokens);
  if (candidates.length === 0) return [];
  const params: unknown[] = [[...new Set(candidates.map((g) => g.norm))]];
  const scope = andSourceScope("pa.source_id", opts.sourceIds, params);
  const remoteFence = opts.remote
    ? ` AND p.slug NOT LIKE 'life/diary/%' AND lower(btrim(COALESCE(p.type, ''))) NOT IN ('diary', 'journal')
        AND ${ownerOnlyLineageSql("page", "p.slug")}`
    : "";
  const rows = (await engine.query<{ alias_norm: string; slug: string; source_id: string; title: string | null }>(
    `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id AND p.deleted_at IS NULL
      WHERE pa.alias_norm = ANY($1::text[])${scope}${remoteFence}
        AND EXISTS (SELECT 1 FROM documents d
                     WHERE d.source_path = (${PAGE_MIRROR_PATH_SQL})
                       AND COALESCE(d.source_id, 'default') = p.source_id AND ${visibilityClause("d")})
      ORDER BY pa.alias_norm, pa.source_id, pa.slug`,
    params,
  )).rows;
  const byNorm = new Map<string, typeof rows>();
  for (const r of rows) byNorm.set(r.alias_norm, [...(byNorm.get(r.alias_norm) ?? []), r]);

  const queryWords = words(query);
  const inQuery = (name: string): boolean => {
    const w = words(name);
    return w.length > 0 && queryWords.some((_, i) => w.every((t, j) => queryWords[i + j] === t));
  };
  const covered = new Set<number>();
  const out: AliasFanout[] = [];
  for (const g of candidates) {
    if (out.length >= MAX_ALIAS_FANOUT) break;
    const claimants = byNorm.get(g.norm) ?? [];
    if (claimants.length !== 1) continue;
    let overlaps = false;
    for (let i = g.from; i <= g.to; i++) if (covered.has(i)) overlaps = true;
    if (overlaps) continue;
    const page = claimants[0]!;
    const name = pageName(page.title, page.slug);
    if (!name || inQuery(name)) continue;
    for (let i = g.from; i <= g.to; i++) covered.add(i);
    const start = tokens[g.from]!.start;
    const end = tokens[g.to]!.end;
    out.push({ alias: g.text, slug: page.slug, source_id: page.source_id, query: query.slice(0, start) + name + query.slice(end) });
  }
  return out;
}
