/**
 * Result-time folding of redirect stubs and cross-source twins: one page,
 * one place in the results.
 *
 * Runs on the ranked list after the alias hop, so the places it frees go to
 * other pages. Two kinds of page fold into another:
 *   - redirect: a page that hands its identity to another page of its source:
 *     frontmatter `redirect_to` / `redirect` / `merged_into` (or an alias or
 *     redirect `status` with `superseded_by`), a `*-redirect` page type, or a
 *     whole page body of at most REDIRECT_BODY_MAX_CHARS that says it was
 *     merged or moved into a linked page. The target takes the stub's place
 *     when the stub ranked higher. A target missing from the results is read
 *     in through the caller's source and visibility predicates and page
 *     filters (never for a remote caller); a bare-word target resolves only
 *     when exactly one page of the source in the results ends in that word. A
 *     stub whose target cannot be shown stays, stamped `redirect_to` with the
 *     target as the stub itself writes it (for an operator or tenant caller,
 *     never a remote one).
 *   - twin: the same slug in another source, when the two pages are copies
 *     (identical text, or most of the shorter one's words in the other). The
 *     better-ranked one stays and names the other in `collapsed`.
 * The per-page key inside one source (a page's mirror, truth mirror and file
 * twin) stays the per-page cap's job. MEMRAIN_SEARCH_COLLAPSE=0 turns this
 * off. Fail-open: a failed read folds nothing it depended on.
 */
import type { Engine } from "../engine/interface.ts";
import type { PageFilters } from "./filters.ts";
import type { Intent } from "./intent.ts";
import { andSourceScope } from "../source-scope.ts";
import { pageKeyFor } from "./page-fusion.ts";
import { slugCandidatesForPath } from "./page-slug.ts";

/** Default ON; MEMRAIN_SEARCH_COLLAPSE=0 disables. */
export function collapseEnabled(): boolean {
  return process.env["MEMRAIN_SEARCH_COLLAPSE"] !== "0";
}

/** A stub body: "This page has been merged into [[target]]" / "... moved to [Target](/companies/target)". */
const REDIRECT_BODY = /\b(?:has been|was|is now|been)\s+(?:merged|moved|redirected|consolidated|folded)\s+(?:in)?to\s+(\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\))/i;
/** A page that also carries real content is not a redirect by its body text alone. */
export const REDIRECT_BODY_MAX_CHARS = 600;
const REDIRECT_TYPE = /(?:^|-)redirect$/i;
const FIRST_LINK = /\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\)/;
/** Share of the shorter text's words the other must contain: twins are copies, a summary keeps fewer. */
const TWIN_OVERLAP = 0.5;
const STOPWORDS = new Set(["the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "has", "have", "had", "but",
  "not", "you", "our", "their", "its", "into", "about", "will", "can", "all", "any", "one", "they", "them", "his", "her", "she",
  "him", "who", "what", "when", "which", "also", "than", "then", "there", "these", "those", "been", "more", "most", "some",
  "such", "only", "other", "over", "each"]);

export interface CollapsedRef {
  slug: string;
  source_id: string;
  reason: "twin" | "redirect";
}

export interface CollapsibleHit {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  content: string;
  score: number;
  source_id?: string | null;
  collapsed?: CollapsedRef[];
  redirect_to?: string;
}

/** A redirect value as a slug: `[[people/x|X]]`, `[X](/people/x.md#a)`, `people/x.md` and `/people/x` are `people/x`. */
export function redirectTargetSlug(value: string): string | null {
  let v = value.trim();
  const md = v.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  if (md) v = md[1]!;
  v = v.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0]!.split("#")[0]!.trim();
  v = v.replace(/^<|>$/g, "").replace(/^\.?\/+/, "").replace(/\.md$/i, "").trim();
  return v && !/^[a-z]+:\/\//i.test(v) ? v : null;
}

function wordSet(text: string | null | undefined): Set<string> | null {
  if (!text) return null;
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !STOPWORDS.has(w)));
  return words.size >= 5 ? words : null;
}

/** Share of the smaller word set found in the larger; 0 when either text is too short to say. */
function overlap(a: Set<string> | null, b: Set<string> | null): number {
  if (!a || !b) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / small.size;
}

const leaf = (slug: string): string => (slug.split("/").pop() ?? slug).toLowerCase();

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The redirect target a page's frontmatter names, as written, or null. */
function frontmatterTarget(fm: Record<string, unknown>): string | null {
  const direct = str(fm["redirect_to"]) ?? str(fm["redirect"]) ?? str(fm["merged_into"]);
  if (direct) return direct;
  const status = str(fm["status"])?.toLowerCase();
  return status === "alias" || status === "redirect" ? str(fm["superseded_by"]) : null;
}

interface PageGroup {
  key: string;
  slug: string | null;
  sourceId: string;
  rows: number[];
}

export interface CollapseOptions {
  engine: Engine;
  intent: Intent;
  /** Frontmatter of each hit's document, by chunk id. */
  frontmatterOf: ReadonlyMap<string, unknown>;
  sourceIds?: readonly string[];
  filters?: PageFilters;
  remote?: boolean;
  /** Head chunk of a page as a hit, under the caller's scope; null when it may not be shown. */
  fetchHead: (slug: string, sourceId: string) => Promise<CollapsibleHit | null>;
}

/**
 * Fold redirect stubs into their targets and cross-source twins into one
 * group each (module header). Order-preserving: surviving rows keep their
 * relative order, and a redirect target takes its stub's place when the stub
 * ranked higher. Returns a new array; stamped rows are copies.
 */
export async function collapseResults<T extends CollapsibleHit>(hits: readonly T[], opts: CollapseOptions): Promise<T[]> {
  if (hits.length === 0) return [...hits];
  const groups = new Map<string, PageGroup>();
  const order: string[] = [];
  hits.forEach((h, i) => {
    const sourceId = h.source_id ?? "default";
    const key = pageKeyFor(h.sourcePath, sourceId, h.documentId);
    let g = groups.get(key);
    if (!g) {
      const candidates = slugCandidatesForPath(h.sourcePath, sourceId);
      g = { key, slug: key.startsWith("doc:") ? null : (candidates[1] ?? candidates[0] ?? null), sourceId, rows: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(i);
  });

  // Redirect stubs and the target each names (as written, then as a slug).
  const written = new Map<string, string>();
  const bodyCandidates = new Map<string, string>();
  for (const key of order) {
    const g = groups.get(key)!;
    if (!g.slug) continue;
    const first = hits[g.rows[0]!]!;
    const fm = record(opts.frontmatterOf.get(first.chunkId));
    let raw = frontmatterTarget(fm);
    if (!raw && REDIRECT_TYPE.test(str(fm["type"]) ?? "")) raw = g.rows.map(i => hits[i]!.content).join(" ").match(FIRST_LINK)?.[0] ?? null;
    if (!raw) {
      const body = g.rows.map(i => hits[i]!.content.trim()).find(t => t.length <= REDIRECT_BODY_MAX_CHARS && REDIRECT_BODY.test(t));
      const link = body?.match(REDIRECT_BODY)?.[1];
      if (link) bodyCandidates.set(key, link);
      continue;
    }
    written.set(key, raw);
  }
  if (bodyCandidates.size > 0) {
    // A body-text stub must be the whole page: its document holds no more text than the cap.
    try {
      const docs = [...bodyCandidates.keys()].map(k => hits[groups.get(k)!.rows[0]!]!.documentId);
      const params: unknown[] = [docs];
      const scope = andSourceScope("d.source_id", opts.sourceIds, params);
      const r = await opts.engine.query<{ document_id: string; chars: number | string }>(
        `SELECT c.document_id, sum(length(c.content))::int AS chars
           FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.document_id = ANY($1::text[])${scope}
          GROUP BY c.document_id`,
        params,
      );
      const chars = new Map(r.rows.map(row => [row.document_id, Number(row.chars)]));
      for (const [key, link] of bodyCandidates) {
        const doc = hits[groups.get(key)!.rows[0]!]!.documentId;
        if ((chars.get(doc) ?? Number.POSITIVE_INFINITY) <= REDIRECT_BODY_MAX_CHARS) written.set(key, link);
      }
    } catch {
      // fail-open: no body-text redirects this call
    }
  }

  const keyFor = (sourceId: string, slug: string): string => `${sourceId}:${slug}`;
  const targetOf = new Map<string, string>();
  for (const [key, raw] of written) {
    const g = groups.get(key)!;
    const slug = redirectTargetSlug(raw);
    if (!slug || slug === g.slug) {
      written.delete(key);
      continue;
    }
    let target: string | null = slug;
    if (!slug.includes("/")) {
      const inPool = order.map(k => groups.get(k)!).filter(o => o.sourceId === g.sourceId && o.slug && leaf(o.slug) === slug.toLowerCase());
      target = inPool.length === 1 ? inPool[0]!.slug : null;
    }
    if (target && target !== g.slug) targetOf.set(key, keyFor(g.sourceId, target));
  }

  // Targets the results lack are read in under the caller's scope.
  const injected = new Map<string, CollapsibleHit>();
  if (!opts.remote) {
    for (const [stubKey, targetKey] of targetOf) {
      if (groups.has(targetKey) || injected.has(targetKey)) continue;
      const g = groups.get(stubKey)!;
      if (opts.sourceIds !== undefined && !opts.sourceIds.includes(g.sourceId)) continue;
      const slug = targetKey.slice(g.sourceId.length + 1);
      try {
        const head = await opts.fetchHead(slug, g.sourceId);
        if (head) injected.set(targetKey, { ...head, score: hits[g.rows[0]!]!.score });
      } catch {
        // fail-open: the stub stays
      }
    }
  }

  // Each page's representative: a redirect stub folds into its target, a twin into the better-ranked copy.
  const foldInto = new Map<string, { into: string; reason: "redirect" | "twin" }>();
  for (const [stubKey, targetKey] of targetOf) {
    if (groups.has(targetKey) || injected.has(targetKey)) foldInto.set(stubKey, { into: targetKey, reason: "redirect" });
  }
  const bySlug = new Map<string, string>();
  for (const key of order) {
    const g = groups.get(key)!;
    if (!g.slug || foldInto.has(key)) continue;
    const twin = bySlug.get(g.slug);
    if (!twin) {
      bySlug.set(g.slug, key);
      continue;
    }
    const a = hits[groups.get(twin)!.rows[0]!]!.content;
    const b = hits[g.rows[0]!]!.content;
    if (a.trim() === b.trim() || overlap(wordSet(a), wordSet(b)) >= TWIN_OVERLAP) foldInto.set(key, { into: twin, reason: "twin" });
  }
  // A remote caller is not shown what a stub's frontmatter names.
  const unresolved = new Map(opts.remote ? [] : [...written].filter(([k]) => !foldInto.has(k)));
  if (foldInto.size === 0 && unresolved.size === 0) return [...hits];

  const rootOf = (key: string): string => {
    let k = key;
    for (let i = 0; i < 8 && foldInto.has(k); i++) k = foldInto.get(k)!.into;
    return k;
  };
  const members = new Map<string, CollapsedRef[]>();
  for (const [key, { reason }] of foldInto) {
    const root = rootOf(key);
    const g = groups.get(key)!;
    members.set(root, [...members.get(root) ?? [], { slug: g.slug!, source_id: g.sourceId, reason }]);
  }

  const out: T[] = [];
  const placed = new Set<string>();
  const stamp = (h: T, key: string, first: boolean): T => {
    const collapsed = first ? members.get(key) : undefined;
    const redirectTo = first ? unresolved.get(key) : undefined;
    if (!collapsed && !redirectTo) return h;
    return { ...h, ...(collapsed ? { collapsed: [...(h.collapsed ?? []), ...collapsed] } : {}), ...(redirectTo ? { redirect_to: redirectTo } : {}) };
  };
  const placeGroup = (key: string): void => {
    if (placed.has(key)) return;
    placed.add(key);
    const g = groups.get(key);
    if (g) {
      g.rows.forEach((i, n) => out.push(stamp(hits[i]!, key, n === 0)));
      return;
    }
    const head = injected.get(key);
    if (head) out.push(stamp({ ...head, intent: opts.intent } as unknown as T, key, true));
  };
  for (const key of order) {
    if (foldInto.has(key)) {
      // A redirect stub's place goes to its target when the stub ranked higher.
      if (foldInto.get(key)!.reason === "redirect") placeGroup(rootOf(key));
      continue;
    }
    placeGroup(key);
  }
  return out;
}
