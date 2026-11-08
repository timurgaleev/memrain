/**
 * Push-based context — resolver core.
 *
 * Given salient candidate surface-forms (from entity-salience.ts) and an
 * Engine, resolve the ones that map to an EXISTING brain page and return
 * compact POINTERS (display -> slug -> safe one-line synopsis). Detect + point,
 * NEVER auto-dump the body — the caller opens the page deliberately.
 *
 * Deterministic, zero-LLM. Precision-biased resolution (no trgm-fuzzy here):
 *   1. alias-first   — page_aliases exact, unambiguous single-slug only
 *   2. title         — lower(title) exact
 *   3. slug-suffix   — slug equals the slugified candidate OR ends with `/<slug>`
 *      (real slugs are namespaced people/alice; a bare slugify misses).
 *
 * memrain specifics:
 *   - One pointer per candidate name and source; entity pages win ambiguous names.
 *   - DB access via `engine.query` (-> {rows}).
 *   - Alias arm uses memrain's `resolveAliasUnique` (page-aliases.ts), which
 *     already enforces the unambiguous-single-slug rule and degrades on a
 *     pre-034 brain.
 *   - Synopsis source is `markdown_body` (memrain's prose column) or a curated
 *     `compiled_truth.summary`; both the facts-fence and the takes-fence are
 *     stripped so no fenced metadata (including holder-scoped takes) leaks into
 *     the ambient synopsis.
 */

import type { OnGatherFailure } from "../gather-degraded.ts";
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { normalizeAlias, resolveAliasUnique } from "../page-aliases.ts";
import { slugifyTarget } from "../links.ts";
import { stripFactsFence } from "../facts-fence.ts";
import { stripTakesFence } from "../synthesis/takes-fence.ts";
import { andSourceScope } from "../source-scope.ts";
import type { EntityCandidate } from "./entity-salience.ts";

const SYNOPSIS_MAX = 160;

/** Which resolution arm produced a pointer (provenance -> honest confidence). */
export type ResolveArm = "alias" | "title" | "slug-suffix";

/**
 * Arm -> base confidence. Lives next to the arm definitions so arm identity
 * and its score can't drift apart. The volunteer layer imports these; small
 * deterministic boosts (multi-turn / newest-turn) are added on top there.
 */
export const ARM_CONFIDENCE: Record<ResolveArm, number> = {
  alias: 0.9,
  title: 0.8,
  "slug-suffix": 0.6,
};

export interface ReflexPointer {
  slug: string;
  title: string;
  /** Owning source of the resolved page. */
  source_id?: string | null;
  /** Resolution provenance. */
  arm: ResolveArm;
  /** Base arm confidence (ARM_CONFIDENCE[arm]); callers may boost. */
  confidence: number;
  /**
   * normalizeAlias form of the CANDIDATE that resolved this pointer — lets the
   * volunteer layer join pointers back to window-salience metadata without
   * guessing from the display label. Absent only when suffix classification
   * couldn't recover the source candidate.
   */
  matchedNorm: string;
  /** Human display label (matched candidate surface, else page title). */
  display: string;
  /** Privacy-safe one-line synopsis (facts-fence stripped). */
  synopsis: string;
}

export interface ResolvePointersOpts {
  onDegraded?: OnGatherFailure;
  maxPointers?: number;
  /**
   * Tenant read scope. Every arm (alias index + the two page lookups) filters on
   * it, so a scoped caller can never resolve a pointer to a page outside its
   * grant; `[]` resolves nothing. Omitted -> unscoped (local CLI / operator path).
   */
  sourceIds?: string[];
}

interface PageRow {
  slug: string;
  source_id: string;
  title: string | null;
  type: string | null;
  compiled_truth: Record<string, unknown> | null;
  markdown_body: string | null;
}

const DEFAULT_MAX_POINTERS = 5;

/**
 * Resolve candidates to pointers, confidence-ordered (alias > title >
 * slug-suffix). Returns [] when nothing resolves. Never throws for data
 * reasons — the alias arm degrades independently on a pre-034 brain.
 */
export async function resolveEntitiesToPointers(
  storage: Storage,
  candidates: EntityCandidate[],
  opts: ResolvePointersOpts = {},
): Promise<ReflexPointer[]> {
  if (!candidates.length) return [];
  const maxPointers = opts.maxPointers ?? DEFAULT_MAX_POINTERS;
  const engine = storage.engine();
  const scope = opts.sourceIds;

  // Derive lookup keys once. displayByNorm recovers a human surface form for a
  // resolved slug; titleToNorm / slugToNorm give arm-2 provenance.
  const displayByNorm = new Map<string, string>();
  const aliasNorms: string[] = [];
  const titlesLc: string[] = [];
  const exactSlugs: string[] = [];
  const slugSuffixes: string[] = [];
  const titleToNorm = new Map<string, string>();
  const slugToNorm = new Map<string, string>();
  for (const c of candidates) {
    const norm = normalizeAlias(c.query);
    if (!norm) continue;
    if (!displayByNorm.has(norm)) displayByNorm.set(norm, c.display);
    aliasNorms.push(norm);
    const tl = c.query.toLowerCase();
    titlesLc.push(tl);
    if (!titleToNorm.has(tl)) titleToNorm.set(tl, norm);
    const s = slugifyTarget(c.query);
    if (s && s !== "unknown") {
      exactSlugs.push(s);
      slugSuffixes.push(`%/${s}`);
      if (!slugToNorm.has(s)) slugToNorm.set(s, norm);
    }
  }
  if (!aliasNorms.length) return [];

  // Ordered set of resolved slugs with arm provenance — alias hits pushed
  // first -> higher confidence. Dedupe on slug (flat vault, slug is unique).
  const resolved: Array<{ slug: string; arm: ResolveArm; matchedNorm: string }> = [];
  const seen = new Set<string>();
  const push = (slug: string, arm: ResolveArm, matchedNorm: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    resolved.push({ slug, arm, matchedNorm });
  };

  // Arm 1 — alias-first. resolveAliasUnique enforces the unambiguous
  // single-slug rule and degrades to null on a pre-034 brain. excludeSlug is a
  // sentinel that matches no real page (so nothing is excluded).
  for (const norm of aliasNorms) {
    try {
      const slug = await resolveAliasUnique(storage, norm, "", scope);
      if (slug) push(slug, "alias", norm);
    } catch {
      opts.onDegraded?.("alias_lookup_failed");
    }
  }

  // Arm 2 — exact title OR slug / slug-suffix. A bare "Alice" slugifies to
  // `alice`, but the real page lives at `people/alice`, so a plain `slug = ANY`
  // misses; match lower(title) exactly OR the slug suffix.
  let rows: PageRow[] = [];
  try {
    const params: unknown[] = [titlesLc, exactSlugs, slugSuffixes];
    const scopeFilter = andSourceScope("source_id", scope, params);
    const r = await engine.query<PageRow>(
      `SELECT slug, source_id, title, type, compiled_truth, markdown_body
         FROM pages
        WHERE deleted_at IS NULL
          AND ( lower(title) = ANY($1::text[])
             OR slug = ANY($2::text[])
             OR slug LIKE ANY($3::text[]) )${scopeFilter}
        ORDER BY slug`,
      params,
    );
    rows = r.rows;
  } catch {
    opts.onDegraded?.("entity_lookup_failed");
    rows = [];
  }

  // Hydrate alias-resolved pages too (their bodies for the synopsis).
  const rowBySlug = new Map<string, PageRow>();
  for (const r of rows) rowBySlug.set(r.slug, r);
  const aliasOnly = resolved.filter((p) => !rowBySlug.has(p.slug));
  if (aliasOnly.length) {
    try {
      const params: unknown[] = [aliasOnly.map((p) => p.slug)];
      const scopeFilter = andSourceScope("source_id", scope, params);
      const extra = await engine.query<PageRow>(
        `SELECT slug, source_id, title, type, compiled_truth, markdown_body
           FROM pages
          WHERE deleted_at IS NULL AND slug = ANY($1::text[])${scopeFilter}
          ORDER BY slug`,
        params,
      );
      for (const r of extra.rows) rowBySlug.set(r.slug, r);
    } catch {
      opts.onDegraded?.("alias_lookup_failed");
    }
  }

  // Title/slug matches that weren't alias hits, appended after alias hits. Arm
  // provenance per row is classified in JS — the combined OR can't report which
  // predicate matched: an exact lower(title) hit is the 'title' arm; anything
  // else got in via slug / slug-suffix.
  const titleSet = new Set(titlesLc);
  for (const r of rows) {
    const titleLc = (r.title ?? "").toLowerCase();
    if (titleLc && titleSet.has(titleLc)) {
      push(r.slug, "title", titleToNorm.get(titleLc) ?? normalizeAlias(r.title ?? ""));
    } else {
      const tail = r.slug.includes("/")
        ? r.slug.slice(r.slug.lastIndexOf("/") + 1)
        : r.slug;
      push(r.slug, "slug-suffix", slugToNorm.get(r.slug) ?? slugToNorm.get(tail) ?? "");
    }
  }

  const priority = (hit: typeof resolved[number]): number => {
    if (slugToNorm.get(hit.slug) === hit.matchedNorm) return 0;
    const row = rowBySlug.get(hit.slug);
    return /^(people|companies|projects)\//.test(hit.slug) || row?.type === "person" || row?.type === "company" ? 1 : 2;
  };
  const ordered = [...resolved].sort((a, b) => priority(a) - priority(b)
    || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const preferred = new Map<string, string>();
  for (const hit of ordered) {
    const row = rowBySlug.get(hit.slug);
    if (!row) continue;
    const key = JSON.stringify([hit.matchedNorm, row.source_id]);
    if (!preferred.has(key)) preferred.set(key, hit.slug);
  }
  const pointers: ReflexPointer[] = [];
  for (const { slug, arm, matchedNorm } of resolved) {
    const row = rowBySlug.get(slug);
    if (!row) continue;
    const nameKey = JSON.stringify([matchedNorm, row.source_id]);
    if (preferred.get(nameKey) !== slug) continue;
    const display = displayForRow(row, displayByNorm);
    pointers.push({
      slug,
      title: row.title ?? slug,
      source_id: row.source_id,
      arm,
      confidence: ARM_CONFIDENCE[arm],
      matchedNorm,
      display,
      synopsis: safeSynopsis(row),
    });
    if (pointers.length >= maxPointers) break;
  }
  return pointers;
}

/** Recover a display label: prefer the matched candidate surface, else title. */
function displayForRow(row: PageRow, displayByNorm: Map<string, string>): string {
  const byTitle = displayByNorm.get(normalizeAlias(row.title ?? ""));
  if (byTitle) return byTitle;
  const tail = row.slug.includes("/")
    ? row.slug.slice(row.slug.lastIndexOf("/") + 1)
    : row.slug;
  return row.title || tail;
}

/**
 * Privacy-safe synopsis. Prefer a curated `compiled_truth.summary`; otherwise
 * strip the facts- and takes-fences from the body (the same boundary untrusted
 * readers see) and take the first prose sentence. Never returns raw fenced
 * content.
 */
function safeSynopsis(row: PageRow): string {
  const ct = row.compiled_truth ?? {};
  const fmSummary = ct["summary"];
  if (typeof fmSummary === "string" && fmSummary.trim()) {
    return clip(collapse(fmSummary), SYNOPSIS_MAX);
  }
  const body = row.markdown_body ?? "";
  if (!body) return "";
  const stripped = stripTakesFence(stripFactsFence(body));
  const firstProse = stripped
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("<!--"));
  if (!firstProse) return "";
  const sentence = firstProse.split(/(?<=[.!?])\s/)[0] ?? firstProse;
  return clip(collapse(sentence), SYNOPSIS_MAX);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/** Re-exported for callers that only need the Engine handle shape. */
export type { Engine };
