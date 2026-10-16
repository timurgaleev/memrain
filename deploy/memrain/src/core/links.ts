/**
 * Links -- page-to-page typed graph CRUD over migration 016_links_typed.
 *
 * Two write paths:
 *   1. Explicit (`addLink` / `removeLink`) -- the agent or a skill is
 *      asserting a typed relationship. Confidence defaults to 1.0.
 *   2. Implicit (`extractWikilinks` + `syncWikilinksForPage`) -- the
 *      deterministic [[wikilink]] scanner derives `type=wikilink`
 *      edges from a page's markdown_body. Idempotent: re-running on
 *      the same body replaces the wikilink edge set for that source
 *      slug, never touching edges of other types.
 *
 * NL-pattern extraction for works_at / attended / founded / ... is a
 * future commit: those patterns need their own test fixture corpus.
 * For now the agent writes those types via the explicit `link` MCP
 * tool.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";
import { inferLinkType, edgeContextWindow } from "./link-verb-infer.ts";
import { linkWatermarkSql } from "./link-watermark.ts";
import { quarantineFilterFragment } from "./quarantine.ts";
import { lockWantedTargets, reconnectAppearedTargets, replaceWantedLinks } from "./wanted-links.ts";

// Catalogue of well-known link types. Not a DB constraint -- extensible
// at runtime. New types may be passed with `allowAdHocType: true`.
export const KNOWN_LINK_TYPES = [
  "wikilink",
  "mentions",
  "works_at",
  "attended",
  "founded",
  "advises",
  "invested_in",
  "knows",
  "met",
  "located_at",
  "related_to",
  "supersedes",
  "contradicts",
  // Doc→code graph: a markdown page that cites `src/foo.ts:42` documents that
  // code file. Only the forward edge exists here — a reverse `documented_by`
  // would need the code file as source_slug, but that column is FK-bound to
  // `pages` and code lives in `documents`, so the reverse is unrepresentable.
  "documents",
] as const;

export type KnownLinkType = (typeof KNOWN_LINK_TYPES)[number];

// Same kebab-case + optional `/` namespaces grammar as pages. Validate
// at the boundary so a future MCP write call can never poison the
// `links.target_slug` column with garbage. Permissive on input ("Alice
// Smith") -- see `slugifyTarget` below -- strict on output.
// Word chars are lowercase/caseless letters of any script plus combining
// marks and digits (\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}) — a Cyrillic or CJK title
// makes a real slug instead of collapsing to `unknown`. ASCII slugs are a
// strict subset, so every existing slug stays valid. (Same grammar in
// pages.ts / insights.ts — keep the three copies in sync.)
const SLUG_WORD = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}]";
// Same set plus the hyphen, for every position after a segment's first char.
const SLUG_TAIL = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}-]";
const SLUG_RE = new RegExp(
  `^${SLUG_WORD}${SLUG_TAIL}*(?:\\/${SLUG_WORD}${SLUG_TAIL}*)*$`,
  "u",
);
const MAX_SLUG_LEN = 256;

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("link slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`link slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `link slug must match kebab-case with optional / namespaces ` +
        `(got ${JSON.stringify(slug)})`,
    );
  }
}

/**
 * Loose name -> strict slug. Lowercase, hyphenate whitespace, drop
 * everything not in [a-z0-9/-]. Preserves `/` so namespaced inputs
 * like `people/alice-smith` round-trip identically. Falls back to
 * `unknown` for empty / all-stripped inputs so we never produce an
 * invalid slug.
 */
export function slugifyTarget(name: string): string {
  if (typeof name !== "string") return "unknown";
  const normalised = name
    .toLowerCase()
    // Compose-y unicode (accented letters, ligatures) -> NFKD pieces.
    .normalize("NFKD")
    // Any whitespace (including unicode spaces) becomes a hyphen.
    .replace(/\s+/g, "-")
    // Keep only ASCII a-z, 0-9, hyphen, slash. Drop everything else.
    .replace(/[^a-z0-9/-]/g, "")
    // Collapse repeated hyphens / slashes that resulted from the strip.
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    // The `(?<![-/])` guard is what keeps the trailing trim linear. The two
    // collapses above only kill `--` and `//`; an alternating `-/-/-/…` run
    // survives them, and `.slice(0, MAX_SLUG_LEN)` lands after this line, so
    // nothing caps what the trim sees. Unguarded, `[-/]+$` restarts inside the
    // run at every offset and walks to the end each time: measured on
    // slugifyTarget with `a` + `-/`*n + `b`, 300 ms at 25 K chars, 20 s at
    // 200 K, ratio 4.0 on a doubling. The guard admits only the first char of
    // each run, so the total walk is the sum of the run lengths — 55 ms at
    // 2 M chars, ratio 2.0. Same language: a greedy `[-/]+$` already only ever
    // matched the maximal trailing run, verified over 400 K random strings.
    .replace(/^[-/]+|(?<![-/])[-/]+$/g, "")
    .slice(0, MAX_SLUG_LEN);
  if (normalised.length > 0) return normalised;
  // The ASCII fold stripped everything — an all-non-Latin name (Cyrillic,
  // CJK, …). Keep the script instead of collapsing every such mention onto
  // the shared `unknown` target, which made those wikilinks permanently
  // unresolvable. NFKC (not NFKD) so letters stay composed and stable as
  // stored slugs; the char class mirrors SLUG_RE above.
  const unicode = name
    .toLowerCase()
    .normalize("NFKC")
    // Variation selectors (emoji VS15/VS16, ideographic IVS) are \p{M} and
    // would survive the keep-class below, so `東京` with and without U+FE0F forked into two
    // slugs. The ASCII pass above already drops them.
    .replace(/\p{Variation_Selector}/gu, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}/-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    // Same trailing-trim guard as the ASCII path above, and reachable by the
    // same input: `-/-/…` folds to empty on the ASCII pass, which is exactly
    // what routes it here. Measured 265 ms at 25 K chars unguarded (ratio 4.0),
    // linear guarded.
    .replace(/^[-/]+|(?<![-/])[-/]+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    // The UTF-16 slice can cut an astral-plane pair in half; a trailing lone
    // high surrogate would abort the Postgres TEXT write downstream.
    .replace(/[\uD800-\uDBFF]$/, "");
  return unicode.length > 0 ? unicode : "unknown";
}

function normaliseType(
  type: string | undefined,
  allowAdHoc: boolean | undefined,
): string {
  if (!type || typeof type !== "string") {
    throw new Error("link type is required");
  }
  const t = type.trim().toLowerCase();
  if (!t) throw new Error("link type cannot be blank");
  if (!allowAdHoc && !KNOWN_LINK_TYPES.includes(t as KnownLinkType)) {
    throw new Error(
      `link type ${JSON.stringify(t)} not in KNOWN_LINK_TYPES; ` +
        `pass allowAdHocType: true to accept it`,
    );
  }
  return t;
}

function normaliseConfidence(c: number | undefined): number {
  if (c === undefined) return 1.0;
  if (typeof c !== "number" || Number.isNaN(c)) {
    throw new TypeError("confidence must be a number in [0, 1]");
  }
  if (c < 0 || c > 1) {
    throw new Error("confidence must be in [0, 1]");
  }
  return c;
}

/** Edge derivation kind for the EXPLICIT `addLink` input — see migration 029.
 *  NOTE: the DB CHECK also allows `'verb_ner'` (migration 053, prose
 *  verb-inference), but that is an INTERNAL origin written only by
 *  `syncVerbLinksForPage` via raw SQL — it is intentionally NOT a valid explicit
 *  `addLink` input, so `normaliseLinkKind` still rejects it. Graph reads don't
 *  project `link_kind`, so the narrower input type never mis-reads a verb_ner row. */
export type LinkKind = "plain" | "typed_ner";
/** Wikilink resolution form — see migration 029. */
export type ResolutionType = "qualified" | "unqualified";

export interface LinkRow {
  id: number;
  source_slug: string;
  target_slug: string;
  type: string;
  inferred_confidence: number;
  source_chunk_id: string | null;
  written_at: string;
  // Provenance (migration 029) — populated by enrichment passes, NULL/empty
  // for explicit `link` calls and pre-029 edges. Optional on the type because
  // the graph-read projections (graphNeighbors / graphQuery) deliberately do
  // NOT select them — a partial LinkRow omits them entirely.
  context?: string;
  link_kind?: LinkKind | null;
  origin_slug?: string | null;
  origin_field?: string | null;
  resolution_type?: ResolutionType | null;
}

export interface AddLinkInput {
  source_slug: string;
  target_slug: string;
  type: string;
  confidence?: number;
  source_chunk_id?: string;
  allowAdHocType?: boolean;
  // Provenance (migration 029) — optional; written by enrichment callers,
  // omitted by the explicit `link` MCP tool. On an idempotent re-add these
  // are sticky: an omitted field preserves the previously-stored value.
  context?: string;
  link_kind?: LinkKind;
  origin_slug?: string;
  origin_field?: string;
  resolution_type?: ResolutionType;
  /**
   * Tenant source scope (migration 047). Omitted -> the column DEFAULT
   * 'default' applies, preserving whole-brain behavior.
   */
  source_id?: string;
}

/** Upper bound on the stored mention-context window (defence vs unbounded writes). */
const MAX_CONTEXT_LEN = 4000;
const MAX_ORIGIN_FIELD_LEN = 256;

function normaliseLinkKind(v: string | undefined): LinkKind | null {
  if (v === undefined) return null;
  if (v !== "plain" && v !== "typed_ner") {
    throw new Error(`link_kind must be 'plain' | 'typed_ner' (got ${JSON.stringify(v)})`);
  }
  return v;
}

function normaliseResolutionType(v: string | undefined): ResolutionType | null {
  if (v === undefined) return null;
  if (v !== "qualified" && v !== "unqualified") {
    throw new Error(
      `resolution_type must be 'qualified' | 'unqualified' (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

export interface AddLinkResult {
  source_slug: string;
  target_slug: string;
  type: string;
  /** True when the (source, target, type) tuple did not exist before. */
  created: boolean;
}

/**
 * Idempotent add. Re-inserting an existing (source, target, type)
 * tuple updates the confidence + chunk_id but doesn't error and
 * doesn't double-count. The UNIQUE index on the tuple guarantees
 * single-row outcome.
 */
export async function addLink(
  storage: Storage,
  input: AddLinkInput,
): Promise<AddLinkResult> {
  validateSlug(input.source_slug);
  const target = slugifyTarget(input.target_slug);
  // After slugify the target should validate; if not the input was
  // pathological (empty after stripping).
  validateSlug(target);
  const type = normaliseType(input.type, input.allowAdHocType);
  const conf = normaliseConfidence(input.confidence);
  const chunkId = input.source_chunk_id ?? null;
  // Provenance (migration 029). Validate at the boundary so a bad caller
  // can't poison the enum/origin columns.
  const context = (input.context ?? "").slice(0, MAX_CONTEXT_LEN);
  const linkKind = normaliseLinkKind(input.link_kind);
  let originSlug: string | null = null;
  if (input.origin_slug !== undefined) {
    validateSlug(input.origin_slug);
    originSlug = input.origin_slug;
  }
  const originField =
    input.origin_field === undefined
      ? null
      : input.origin_field.slice(0, MAX_ORIGIN_FIELD_LEN);
  const resolutionType = normaliseResolutionType(input.resolution_type);
  // Tenant scope (mig047): stamp source_id only when provided so the NOT NULL
  // column's DEFAULT 'default' applies otherwise (never pass NULL).
  const sourceId =
    typeof input.source_id === "string" && input.source_id.length > 0
      ? input.source_id
      : null;
  const sourceCol = sourceId !== null ? ", source_id" : "";
  const sourceVal = sourceId !== null ? ", $11" : "";
  const params: unknown[] = [
    input.source_slug, target, type, conf, chunkId,
    context, linkKind, originSlug, originField, resolutionType,
  ];
  if (sourceId !== null) params.push(sourceId);
  // On an idempotent re-add, provenance is STICKY: an omitted field (empty
  // context / NULL enum) preserves the prior value so a bare `link` re-call
  // never wipes enrichment-written provenance. `link_source='manual'` (mig086):
  // an explicit call owns the manual edge row; a same-triple edge from a
  // derived writer (markdown / frontmatter / mentions) is a SEPARATE row under
  // the widened key, so re-adding never tampers with a derived writer's edge.
  const r = await storage.engine().query<{ inserted: boolean }>(
    `INSERT INTO links
       (source_slug, target_slug, type, inferred_confidence, source_chunk_id,
        context, link_kind, origin_slug, origin_field, resolution_type,
        link_source${sourceCol})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual'${sourceVal})
     ON CONFLICT (source_slug, target_slug, type, source_id, link_source) DO UPDATE
       SET inferred_confidence = EXCLUDED.inferred_confidence,
           source_chunk_id     = EXCLUDED.source_chunk_id,
           context             = CASE WHEN EXCLUDED.context <> ''
                                      THEN EXCLUDED.context ELSE links.context END,
           link_kind           = COALESCE(EXCLUDED.link_kind, links.link_kind),
           origin_slug         = COALESCE(EXCLUDED.origin_slug, links.origin_slug),
           origin_field        = COALESCE(EXCLUDED.origin_field, links.origin_field),
           resolution_type     = COALESCE(EXCLUDED.resolution_type, links.resolution_type)
     RETURNING (xmax = 0) AS inserted`,
    params,
  );
  return {
    source_slug: input.source_slug,
    target_slug: target,
    type,
    created: r.rows[0]?.inserted ?? false,
  };
}

export interface RemoveLinkInput {
  source_slug: string;
  target_slug: string;
  type: string;
  /**
   * Tenant write scope (migration 047). When set, only an edge owned by this
   * source is removed — a scoped caller can never delete another tenant's edge.
   * Omitted/empty → no filter (whole-brain by tuple, unchanged).
   */
  source_id?: string;
}

export async function removeLink(
  storage: Storage,
  input: RemoveLinkInput,
): Promise<{ removed: number }> {
  validateSlug(input.source_slug);
  const target = slugifyTarget(input.target_slug);
  const type = normaliseType(input.type, true);
  const scope =
    typeof input.source_id === "string" && input.source_id.length > 0
      ? input.source_id
      : null;
  const params: unknown[] = [input.source_slug, target, type];
  let sourceFilter = "";
  if (scope !== null) {
    params.push(scope);
    sourceFilter = ` AND source_id = $${params.length}`;
  }
  const r = await storage.engine().query<{ removed: number }>(
    `WITH d AS (
       DELETE FROM links
        WHERE source_slug = $1 AND target_slug = $2 AND type = $3${sourceFilter}
        RETURNING 1
     )
     SELECT COUNT(*)::int AS removed FROM d`,
    params,
  );
  return { removed: r.rows[0]?.removed ?? 0 };
}

/**
 * SQL that is true unless the endpoint `slugExpr` names a page the reader must
 * not see: one that is soft-deleted, or whose body mirror is archived or
 * quarantined. An endpoint with no page row at all stays — a dangling wikilink
 * target, or a name a vault note links to, is not hidden by anything. Every
 * graph read applies it to both ends of an edge.
 *
 * The mirror's own `deleted_at` is not consulted: a restored page is live
 * before the mirror phase re-indexes it, and its edges must not vanish in
 * between.
 */
export function liveEndpointSql(slugExpr: string): string {
  if (!/^(?:[a-z_]\w*\.)?[a-z_]\w*$/i.test(slugExpr)) {
    throw new Error(`unsafe SQL column: ${JSON.stringify(slugExpr)}`);
  }
  return `NOT EXISTS (
      SELECT 1 FROM pages hp
       WHERE hp.slug = ${slugExpr}
         AND (hp.deleted_at IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM documents hd
                 WHERE hd.source_path = CASE
                         WHEN hp.source_id IS NULL OR hp.source_id = 'default' THEN 'page://' || hp.slug
                         ELSE 'page://' || hp.source_id || '/' || hp.slug END
                   AND (hd.archived OR NOT ${quarantineFilterFragment("hd")}))))`;
}

/** Both ends of the edge aliased `alias` are visible. */
export function liveEdgeSql(alias: string): string {
  return `${liveEndpointSql(`${alias}.source_slug`)} AND ${liveEndpointSql(`${alias}.target_slug`)}`;
}

export interface GraphNeighborsOptions {
  type?: string;
  direction?: "outbound" | "inbound" | "both";
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, edges are filtered
   * to `source_id = ANY(...)`. Omitted -> unscoped (whole-brain); `[]` -> nothing.
   */
  sourceIds?: string[];
}

export interface NeighborRow extends LinkRow {
  /** "outbound" -> this slug is the source; "inbound" -> this slug is the target. */
  direction: "outbound" | "inbound";
}

/**
 * Page-centric graph traversal: all links touching `slug` in the
 * given direction (default `both`). Optional `type` filter.
 */
export async function graphNeighbors(
  storage: Storage,
  slug: string,
  opts: GraphNeighborsOptions = {},
): Promise<NeighborRow[]> {
  validateSlug(slug);
  const direction = opts.direction ?? "both";
  if (!["outbound", "inbound", "both"].includes(direction)) {
    throw new Error(
      `graphNeighbors: direction must be outbound|inbound|both (got ${direction})`,
    );
  }
  const type = opts.type ? normaliseType(opts.type, true) : null;
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  const params: unknown[] = [slug];
  let typeFilter = "";
  if (type) {
    params.push(type);
    typeFilter = ` AND type = $${params.length}`;
  }
  // Tenant scope (mig047): same filter string applied to both UNION arms.
  const scopeFilter = andSourceScope("source_id", opts.sourceIds, params);
  const queries: string[] = [];
  if (direction === "outbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'outbound' AS direction
       FROM links
       WHERE source_slug = $1${typeFilter}${scopeFilter}
         AND ${liveEdgeSql("links")}`,
    );
  }
  if (direction === "inbound" || direction === "both") {
    queries.push(
      `SELECT id, source_slug, target_slug, type, inferred_confidence,
              source_chunk_id, written_at::text AS written_at,
              'inbound' AS direction
       FROM links
       WHERE target_slug = $1${typeFilter}${scopeFilter}
         AND ${liveEdgeSql("links")}`,
    );
  }
  params.push(limit);
  const sql = `${queries.join("\nUNION ALL\n")}
    ORDER BY written_at DESC
    LIMIT $${params.length}`;
  const r = await storage.engine().query<NeighborRow>(sql, params);
  return r.rows;
}

export interface GraphHubs {
  hubs: { slug: string; title: string | null; type: string; in_degree: number; out_degree: number; degree: number }[];
  /** Visible pages with at least one link to or from another visible page. */
  linked_pages: number;
  /** Links between two visible pages. */
  total_links: number;
  /** Visible pages. */
  total_pages: number;
}

/**
 * The most connected pages of the whole brain, for the admin Graph home. A
 * visible page is a live page row that `liveEndpointSql` keeps; only edges
 * with a visible page at BOTH ends count, so a dangling target (kept by
 * `liveEdgeSql`) adds nothing to either side. Ties go to the page with more
 * inbound links, then to the slug.
 */
export async function graphHubs(engine: Engine, opts: { limit?: number } = {}): Promise<GraphHubs> {
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 20)));
  // The edge set is driven from `links` with PK lookups into `pages`, not by
  // joining a visible-pages CTE to itself: without table statistics (PGLite
  // never analyzes) the planner estimates such a CTE at one row and nests
  // the two scans, which took seconds on a 2k-page brain.
  const visibleEdges = `e AS (
      SELECT l.source_slug AS s, l.target_slug AS t FROM links l
        JOIN pages a ON a.slug = l.source_slug AND a.deleted_at IS NULL
        JOIN pages b ON b.slug = l.target_slug AND b.deleted_at IS NULL
       WHERE l.source_slug <> l.target_slug
         AND ${liveEndpointSql("a.slug")} AND ${liveEndpointSql("b.slug")}
    )`;
  const hubs = await engine.query<{
    slug: string;
    title: string | null;
    type: string;
    in_degree: number;
    out_degree: number;
    degree: number;
  }>(
    `WITH ${visibleEdges}, deg AS (
       SELECT slug, sum(i)::int AS in_degree, sum(o)::int AS out_degree FROM (
         SELECT t AS slug, 1 AS i, 0 AS o FROM e
         UNION ALL SELECT s, 0, 1 FROM e) x
        GROUP BY slug
     )
     SELECT v.slug, v.title, v.type, d.in_degree, d.out_degree,
            (d.in_degree + d.out_degree)::int AS degree
       FROM deg d JOIN pages v ON v.slug = d.slug
      ORDER BY degree DESC, d.in_degree DESC, v.slug ASC
      LIMIT $1`,
    [limit],
  );
  const counts = await engine.query<{ linked_pages: number; total_links: number; total_pages: number }>(
    `WITH ${visibleEdges}
     SELECT (SELECT count(*) FROM (SELECT s FROM e UNION SELECT t FROM e) x)::int AS linked_pages,
            (SELECT count(*) FROM e)::int AS total_links,
            (SELECT count(*) FROM pages p
              WHERE p.deleted_at IS NULL AND ${liveEndpointSql("p.slug")})::int AS total_pages`,
  );
  const c = counts.rows[0];
  return {
    hubs: hubs.rows.map((h) => ({
      slug: h.slug,
      title: h.title,
      type: h.type,
      in_degree: Number(h.in_degree),
      out_degree: Number(h.out_degree),
      degree: Number(h.degree),
    })),
    linked_pages: Number(c?.linked_pages ?? 0),
    total_links: Number(c?.total_links ?? 0),
    total_pages: Number(c?.total_pages ?? 0),
  };
}

export interface GraphQueryOptions {
  type: string;
  source_slug?: string;
  target_slug?: string;
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, edges are filtered
   * to `source_id = ANY(...)`. Omitted -> unscoped (whole-brain); `[]` -> nothing.
   */
  sourceIds?: string[];
}

/**
 * Typed-relationship query. Examples:
 *   { type: "works_at", source_slug: "people/alice" }
 *     -> companies Alice works at
 *   { type: "works_at", target_slug: "companies/acme" }
 *     -> people who work at Acme
 *   { type: "wikilink", source_slug: "journal/2026-05-18" }
 *     -> wikilinks referenced from today's journal entry
 *
 * At least one of `source_slug` / `target_slug` is required so we
 * never accidentally return the entire `links` table.
 */
export async function graphQuery(
  storage: Storage,
  opts: GraphQueryOptions,
): Promise<LinkRow[]> {
  const type = normaliseType(opts.type, true);
  if (!opts.source_slug && !opts.target_slug) {
    throw new Error(
      "graphQuery: at least one of source_slug / target_slug is required",
    );
  }
  const params: unknown[] = [type];
  const where: string[] = [`type = $1`];
  if (opts.source_slug) {
    validateSlug(opts.source_slug);
    params.push(opts.source_slug);
    where.push(`source_slug = $${params.length}`);
  }
  if (opts.target_slug) {
    const target = slugifyTarget(opts.target_slug);
    validateSlug(target);
    params.push(target);
    where.push(`target_slug = $${params.length}`);
  }
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  where.push(liveEdgeSql("links"));
  const r = await storage.engine().query<LinkRow>(
    `SELECT id, source_slug, target_slug, type, inferred_confidence,
            source_chunk_id, written_at::text AS written_at
       FROM links
       WHERE ${where.join(" AND ")}
       ORDER BY inferred_confidence DESC, written_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export interface TraverseGraphOptions {
  /** Max hops from the start (1..10). Default 3. */
  maxDepth?: number;
  /** Edge direction to follow. Default `outbound`. */
  direction?: "outbound" | "inbound" | "both";
  /** Optional edge-type filter. */
  type?: string;
  /** Max distinct nodes returned (1..1000). Default 100. */
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, only edges with
   * `source_id = ANY(...)` are traversed. Omitted -> unscoped; `[]` -> nothing.
   */
  sourceIds?: string[];
}

export interface TraverseHit {
  slug: string;
  /** Shortest hop distance from the start node (>= 1). */
  depth: number;
}

/**
 * Recursive N-hop graph walk from `startSlug` over the `links` edge table —
 * the multi-hop counterpart to single-hop `graphNeighbors`/`graphQuery`.
 * Depth-capped, cycle-safe (a node already on the current path is never
 * re-entered), returns each reachable node once at its shortest depth.
 *
 * `direction` selects which way edges are followed; `both` treats the graph as
 * undirected. Bounded by `maxDepth` AND `limit`. Deterministic, no LLM. The SQL
 * avoids LATERAL for PGLite/Postgres portability.
 */
export async function traverseGraph(
  storage: Storage,
  startSlug: string,
  opts: TraverseGraphOptions = {},
): Promise<TraverseHit[]> {
  validateSlug(startSlug);
  const direction = opts.direction ?? "outbound";
  if (!["outbound", "inbound", "both"].includes(direction)) {
    throw new Error(
      `traverseGraph: direction must be outbound|inbound|both (got ${direction})`,
    );
  }
  const maxDepth =
    typeof opts.maxDepth === "number" && opts.maxDepth >= 1 && opts.maxDepth <= 10
      ? Math.floor(opts.maxDepth)
      : 3;
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  const type = opts.type ? normaliseType(opts.type, true) : null;

  // direction → join condition + the "other end" expression. Whitelisted
  // literals (never user input) — safe to interpolate.
  const joinCond =
    direction === "outbound"
      ? "l.source_slug = w.slug"
      : direction === "inbound"
        ? "l.target_slug = w.slug"
        : "(l.source_slug = w.slug OR l.target_slug = w.slug)";
  const nextExpr =
    direction === "outbound"
      ? "l.target_slug"
      : direction === "inbound"
        ? "l.source_slug"
        : "CASE WHEN l.source_slug = w.slug THEN l.target_slug ELSE l.source_slug END";

  const params: unknown[] = [startSlug, maxDepth];
  let typeFilter = "";
  if (type) {
    params.push(type);
    typeFilter = ` AND l.type = $${params.length}`;
  }
  // Tenant scope (mig047): confine the walk to edges in the given sources.
  const scopeFilter = andSourceScope("l.source_id", opts.sourceIds, params);
  params.push(limit);
  const limitParam = `$${params.length}`;

  // ponytail: `limit` bounds the OUTPUT (distinct nodes), not the CTE's work —
  // path-based pruning materializes every simple path up to maxDepth, so a
  // DENSE graph at high maxDepth (esp. `both`) can fan out super-linearly
  // before the final GROUP BY. maxDepth (cap 10) is the real cost guard; fine
  // for memrain's small, sparse wiki-link graph. If the graph ever grows dense,
  // switch to a per-iteration visited-set cap or lower the `both` ceiling.
  const r = await storage.engine().query<{ slug: string; depth: number }>(
    `WITH RECURSIVE walk(slug, depth, path) AS (
       SELECT $1::text, 0, ARRAY[$1::text]
       UNION ALL
       SELECT ${nextExpr}, w.depth + 1, w.path || ${nextExpr}
       FROM walk w
       JOIN links l ON ${joinCond}
       WHERE w.depth < $2
         AND NOT (${nextExpr} = ANY(w.path))${typeFilter}${scopeFilter}
         AND ${liveEdgeSql("l")}
     )
     SELECT slug, MIN(depth) AS depth
       FROM walk
      WHERE depth > 0
      GROUP BY slug
      ORDER BY MIN(depth) ASC, slug ASC
      LIMIT ${limitParam}`,
    params,
  );
  return r.rows.map((x) => ({ slug: x.slug, depth: Number(x.depth) }));
}

// ---------------------------------------------------------------------------
// Deterministic [[wikilink]] extractor -- zero LLM, idempotent.
// ---------------------------------------------------------------------------

// Both runs are LENGTH-BOUNDED, and that is the only thing that makes this
// scan linear. Two weaker fixes were tried and measured first, so the reason
// is on the record:
//
//   - Making the runs atomic (`(?=(…))\1`) does nothing here. Atomicity kills
//     give-back, but the cost is not give-back — it is the lookahead itself.
//     `[^\]\n]` excludes only `]` and newline, so on `[[a|` repeated the alias
//     run walks to the END OF THE BODY before failing, and it does that from
//     every one of the n start positions.
//   - Bounding only the target is likewise not enough: the target stops at the
//     `|` after one character, so it was never the expensive half.
//
// Measured on the real extractor, `[[a|` repeated: unbounded 8 K links = 52 ms,
// 64 K = 2.9 s, 256 K = 45 s, 1 MB = 243 s, squaring cleanly. Nothing caps the
// body on this path, so a single indexed page could hold the daemon for
// minutes. Bounded, the same 1 MB input is milliseconds.
//
// The bounds are chosen so no real link is lost: a page slug is capped at 256
// (MAX_SLUG_LEN, core/pages.ts and core/insights.ts), so a longer target could
// never resolve to a page and is not an edge worth extracting. The alias is
// display text and gets a looser 512.
//
// The `(?<!\[)` guard covers the other direction: a start preceded by `[` can
// never win — a match there implies a match one char earlier, which the
// left-to-right scan would already have taken.
const WIKILINK_RE = /(?<!\[)\[\[([^\]\n|]{1,256})(?:\|[^\]\n]{1,512})?\]\]/g;

// `[Name](path)` markdown link. No dir whitelist — the resolver's existence
// check (below) is the gate. Captures the target path; an optional `../` prefix
// and `.md` suffix are peeled in the scanner so filesystem-style and engine-slug
// forms both land on the same slug.
//
// The display-text run is bounded for the same reason WIKILINK_RE's alias is,
// and to the same 512: unbounded, every `[` in a `[[[[…` body starts a candidate
// whose text run walks to the end of the (1 MB-capped) scan looking for a `]`
// that is not there. Measured through extractMarkdownLinks on `[`*n: 428 ms at
// 31 K, 25 s at 250 K, ratio 3.9 on a doubling. Bounded, 894 ms at 2 M with
// ratio 2.0. The cost is the forward scan, so only a bound fixes it — a
// possessive/atomic run was measured still quadratic on the sibling site.
const MARKDOWN_LINK_RE = /\[[^\]\n]{1,512}\]\(([^)\s]+)\)/g;

/** Upper bound on the body scanned by the deterministic extractors (parity with
 *  the gazetteer's cap) — a pathological page can't turn the O(n) scan wasteful. */
const MAX_SCAN_LEN = 1_000_000;

/**
 * Mask fenced (```...```) and inline (`...`) code spans with equal-length
 * whitespace. Length-preserving on purpose: the gazetteer scans by offset, so a
 * collapsing strip would shift every later match. A `[[foo]]` or `[Name](foo)`
 * inside code is a sample, not a real reference — blanking the span keeps it out
 * of the graph without disturbing surrounding positions.
 */
export function stripCodeBlocks(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const end = content.indexOf("```", i + 3);
      if (end === -1) {
        out += " ".repeat(content.length - i);
        break;
      }
      out += " ".repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1 || content.slice(i + 1, end).includes("\n")) {
        out += content[i];
        i++;
        continue;
      }
      out += " ".repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

/**
 * Extract every distinct [[wikilink]] surface form from a markdown
 * body. Returns the original surface forms (not yet slugified) so
 * callers can keep both raw and normalised values if needed.
 *
 * Code spans are masked first (a `[[foo]]` in a fence is a sample). A trailing
 * `#section` anchor is dropped from the target — `[[people/alice#background]]`
 * links the page, not a heading — while a `|display` alias is already handled by
 * the capture group.
 */
export function extractWikilinks(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const scannable = stripCodeBlocks(body);
  const seen = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  for (
    let match = WIKILINK_RE.exec(scannable);
    match !== null;
    match = WIKILINK_RE.exec(scannable)
  ) {
    // Measured linear through extractWikilinks: 100 ms at 8.2 MB of
    // `[[` + `#`*255 + `]]`, ratio 1.8 on a doubling. WIKILINK_RE's group 1 is
    // `[^\]\n|]{1,256}`, so this never sees more than 256 chars and never sees
    // the newline that `.` would have to stop at for `$` to fail.
    // eslint-disable-next-line regexp/no-super-linear-move
    const raw = match[1]?.replace(/#.*$/, "").trim();
    if (raw && raw.length > 0) seen.add(raw);
  }
  return [...seen];
}

/**
 * Extract distinct `[Name](path)` markdown-link targets from a body. External
 * URLs are skipped; a leading `../` and a trailing `.md` are peeled so both
 * `[A](../people/alice.md)` and `[A](people/alice)` yield `people/alice`. A
 * heading anchor is dropped. Code spans are masked as in extractWikilinks.
 * Unlike a bare wikilink, a markdown link only becomes an edge when it resolves
 * to a real page (see syncWikilinksForPage) — memrain has no dir whitelist to
 * pre-filter these.
 */
export function extractMarkdownLinks(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const scannable = stripCodeBlocks(body.slice(0, MAX_SCAN_LEN));
  const seen = new Set<string>();
  MARKDOWN_LINK_RE.lastIndex = 0;
  for (
    let match = MARKDOWN_LINK_RE.exec(scannable);
    match !== null;
    match = MARKDOWN_LINK_RE.exec(scannable)
  ) {
    const captured = match[1];
    if (!captured || captured.includes("://")) continue;
    const target = captured
      .replace(/^(?:\.\.\/)+/, "")
      // Measured linear through extractMarkdownLinks: 5.2 ms at a 500 K-char
      // `#` target, ratio 2.0 on a doubling. MARKDOWN_LINK_RE's group 1 is
      // `[^)\s]+`, which excludes every whitespace char — with no newline in
      // the string `.*` always reaches the end and `$` succeeds at the first
      // `#`, so there is no failing suffix to backtrack over.
      // eslint-disable-next-line regexp/no-super-linear-move
      .replace(/#.*$/, "")
      .replace(/\.md$/, "")
      .trim();
    if (target.length > 0) seen.add(target);
  }
  return [...seen];
}

/**
 * Replace the wikilink-typed outbound link set for a given source
 * page with the wikilinks present in `body`. Other-typed links are
 * untouched. Runs in one transaction so a partial extract never
 * leaves the graph in an inconsistent state.
 *
 * Each raw `[[mention]]` is canonicalized to an EXISTING page slug via
 * the 4-stage resolver (core/slug-canonicalize.ts) before the edge is
 * written, so `[[Alice Smith]]` lands on `people/alice-smith` instead of
 * a dangling `alice-smith`. A mention that resolves to a real page is
 * stamped `resolution_type = 'qualified'`; the slugify fallback is
 * `'unqualified'`. Resolution reads pages/links OUTSIDE the write
 * transaction (the targets are other pages, independent of the edge
 * rewrite); the delete + insert stay transactional, and a dangling target
 * whose page appeared in between is reconnected inside it.
 */
export async function syncWikilinksForPage(
  storage: Storage,
  sourceSlug: string,
  body: string,
  sourceId?: string,
): Promise<{ removed: number; added: number }> {
  validateSlug(sourceSlug);
  // Tenant scope (mig047): stamp source_id on derived edges only when given,
  // else let the column DEFAULT 'default' apply (never pass NULL).
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;

  // Resolve each distinct mention, then collapse to one edge per target
  // slug (two surface forms may canonicalize to the same page). A
  // 'qualified' resolution wins over an 'unqualified' one for the same slug.
  // Scope resolution to the writer's source (mig047) so a tenant's wikilink
  // never canonicalizes onto another tenant's page. Unscoped when NULL.
  const resolver = makeSlugResolver(
    storage,
    sourceSlug,
    scope !== null ? { sourceIds: [scope] } : {},
  );
  const byTarget = new Map<string, boolean>(); // slug -> qualified?
  // References no page answers yet, recorded so the edge can be reconnected
  // when the page appears (wanted-links.ts): target slug -> surface.
  const wanted = new Map<string, string>();
  for (const name of extractWikilinks(body)) {
    const r = await resolver.resolve(name);
    if (r.slug === "unknown") continue;
    // Drop a self-loop: a page linking to itself is graph noise. (The
    // resolver already excludes self from fuzzy/tail/prefix matches; this
    // also catches an explicit `[[own-slug]]` resolved exact/slugify.)
    if (r.slug === sourceSlug) continue;
    const prior = byTarget.get(r.slug);
    byTarget.set(r.slug, (prior ?? false) || r.resolved);
    if (!r.resolved && !wanted.has(r.slug)) wanted.set(r.slug, name);
  }
  // Markdown-style [Name](dir/slug.md) links. A bare wikilink may stay
  // unqualified (a dangling `[[name]]` is an intentional placeholder), but a
  // markdown path is only an edge when it lands on a real page — memrain has no
  // dir whitelist to pre-filter it, so the resolver's existence check is the
  // gate. An unresolved path makes no edge; when it could still name a page
  // it is recorded as wanted, so the edge appears once that page exists.
  for (const path of extractMarkdownLinks(body)) {
    const r = await resolver.resolve(path);
    if (r.slug === sourceSlug || r.slug === "unknown") continue;
    if (r.resolved) byTarget.set(r.slug, true);
    else if (couldNamePage(path) && !wanted.has(r.slug)) wanted.set(r.slug, path);
  }
  for (const slug of [...wanted.keys()]) if (byTarget.get(slug) === true) wanted.delete(slug);

  const engine = storage.engine();
  // When scoped, the delete + insert confine to this source so a per-tenant
  // re-put never clears another tenant's wikilink edges. Unscoped (NULL) keeps
  // the original whole-source behavior.
  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $4" : "";
  return engine.transaction(async (tx) => {
    await lockWantedTargets(tx, wanted);
    const delParams: unknown[] = [sourceSlug];
    if (scope !== null) delParams.push(scope);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND type = 'wikilink'${delScope}
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const [target, qualified] of byTarget) {
      // Each insert is idempotent against UNIQUE(source, target, type).
      // link_kind = 'plain' (deterministic scanner, not typed-NER);
      // resolution_type records whether a real page backed the target.
      const insParams: unknown[] = [
        sourceSlug,
        target,
        qualified ? "qualified" : "unqualified",
      ];
      if (scope !== null) insParams.push(scope);
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence,
            link_kind, resolution_type, link_source${insCol})
         VALUES ($1, $2, 'wikilink', 1.0, 'plain', $3, 'markdown'${insVal})
         ON CONFLICT (source_slug, target_slug, type, source_id, link_source) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        insParams,
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    await replaceWantedLinks(tx, sourceSlug, scope, wanted);
    await reconnectAppearedTargets(tx, scope ?? "default", wanted);
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}

/** A markdown path that a page could answer to: no file extension, no query. */
function couldNamePage(path: string): boolean {
  return !/\.[a-z0-9]{1,8}$/i.test(path) && !/[?=&@:]/.test(path);
}

// --- Verb-context typed edges (migration 053, opt-in) ---------------------

/** Confidence for a regex-inferred verb edge — below an explicit (1.0) or a
 *  frontmatter typed edge, above noise. */
const VERB_INFER_CONFIDENCE = 0.6;

/**
 * Derive typed edges (works_at / invested_in / founded / advises) from the prose
 * around a page's `[[wikilinks]]` and persist them with `link_kind='verb_ner'`.
 * Verb-context extraction wired as a SEPARATE edge source (like gazetteer /
 * typed-links) behind `MEMRAIN_LINK_VERB_INFER`. Opt-in, default OFF.
 *
 * Ownership: DELETE-replaces ONLY this source's `verb_ner` edges, so it never
 * touches `plain` (wikilink + gazetteer) or `typed_ner` (frontmatter) edges. An
 * inferred edge that collides with an explicit / frontmatter edge on the same
 * (source, target, type) yields via `ON CONFLICT DO NOTHING`. The wikilink edge
 * itself is left in place — this only ADDS the typed relationship; a hit whose
 * prose carries no verb (`inferLinkType` → `mentions`) is skipped.
 *
 * `pageType` is the source page's type (drives the meeting/person prior). The
 * per-edge context window is centred on the wikilink surface form (a 240-char
 * radius; the first occurrence of the surface text — a generous window, so a
 * verb a clause away from the mention is still caught).
 *
 * PRECISION CEILING (inherent to regex windowing, why this is opt-in + low-trust):
 * the first-occurrence window can (a) miss a verb attached to a LATER mention of
 * the same target (false negative), or (b) pull a verb belonging to an adjacent
 * entity inside the wide radius (mislabel). The edges are stamped at confidence
 * 0.6 with the `verb_ner` provenance so a consumer can treat them as soft
 * signals, and the person→company role prior backstops verb-less mentions. This
 * is a regex-NER precision class; an LLM pass would be the accuracy ceiling, out
 * of memrain's brain-only scope.
 */
export async function syncVerbLinksForPage(
  storage: Storage,
  sourceSlug: string,
  pageType: string,
  body: string,
  sourceId?: string,
): Promise<{ removed: number; added: number }> {
  validateSlug(sourceSlug);
  const scope = typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;

  // Scope resolution to the writer's source (mig047), as syncWikilinksForPage.
  const resolver = makeSlugResolver(
    storage,
    sourceSlug,
    scope !== null ? { sourceIds: [scope] } : {},
  );
  // target slug -> inferred type. First occurrence's context wins (stable);
  // inferLinkType already encodes the verb precedence within a single window.
  const byTarget = new Map<string, string>();
  for (const surface of extractWikilinks(body)) {
    const r = await resolver.resolve(surface);
    if (r.slug === "unknown" || r.slug === sourceSlug) continue;
    if (byTarget.has(r.slug)) continue;
    const t = inferLinkType(pageType, edgeContextWindow(body, surface), body, r.slug, surface);
    if (t === "mentions") continue; // no typed upgrade — the wikilink edge already covers it
    byTarget.set(r.slug, t);
  }

  const engine = storage.engine();
  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $5" : "";
  return engine.transaction(async (tx) => {
    const delParams: unknown[] = [sourceSlug];
    if (scope !== null) delParams.push(scope);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND link_kind = 'verb_ner'${delScope}
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const [target, type] of byTarget) {
      const insParams: unknown[] = [sourceSlug, target, type, VERB_INFER_CONFIDENCE];
      if (scope !== null) insParams.push(scope);
      // link_source='mentions' (mig086): verb-derived typed edges are filed
      // under the mentions provenance; link_kind='verb_ner' keeps the
      // sweep's ownership discriminator.
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence, link_kind,
            link_source${insCol})
         VALUES ($1, $2, $3, $4, 'verb_ner', 'mentions'${insVal})
         ON CONFLICT (source_slug, target_slug, type, source_id, link_source) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        insParams,
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}

// --- Doc→code citations (a guide cites `src/foo.ts:42`) -------------------

/** A code-path reference found in prose, e.g. `src/core/sync.ts:42`. */
export interface CodeRef {
  /** Repo-relative path as cited, without the `:line` suffix. */
  path: string;
  /** 1-based line number when the citation carried one (`path:NN`). */
  line?: number;
}

// A cited code path is anchored on the common repo-layout dirs so bare prose
// ("see foo/bar for context") never mints a ref; the extension set tracks the
// code indexer's language coverage — a path with no code file behind it is
// noise. Fresh RegExp per call keeps `lastIndex` from leaking across bodies.
const CODE_REF_REGEX =
  /\b((?:src|lib|app|test|tests|scripts|docs|packages|internal|cmd|examples)\/[\w\-./]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|cs|cpp|cc|hpp|c|h|php|swift|kt|scala|lua|ex|exs|elm|ml|dart|zig|sol|sh|bash|css|html|vue|json|yaml|yml|toml))(?::(\d+))?\b/g;

/** Extract distinct cited code paths from prose, deduped by path. */
export function extractCodeRefs(body: string): CodeRef[] {
  if (typeof body !== "string" || body.length === 0) return [];
  // Mask fenced + inline code first, like the wikilink/markdown/entity scans —
  // a path shown inside a ``` example fence is illustration, not a citation, and
  // must not mint a doc→code edge.
  const scannable = stripCodeBlocks(body.slice(0, MAX_SCAN_LEN));
  const seen = new Set<string>();
  const refs: CodeRef[] = [];
  const re = new RegExp(CODE_REF_REGEX.source, "g");
  for (
    let match = re.exec(scannable);
    match !== null;
    match = re.exec(scannable)
  ) {
    const path = match[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    refs.push({ path, line: match[2] ? parseInt(match[2], 10) : undefined });
  }
  return refs;
}

/** Escape LIKE metacharacters so a cited path with `_`/`%` matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Does an indexed code file answer a cited path, exactly or as its suffix?
 * The suffix match runs on the reversed path as a prefix match, which the
 * reverse(source_path) index (migration 138) serves; `LIKE '%/path'` scanned
 * every document per citation. No ESCAPE clause: backslash is LIKE's default
 * escape, and a clause would hide the pattern's prefix from the planner.
 */
export const CODE_REF_LOOKUP_SQL = `SELECT 1 AS one FROM documents
        WHERE frontmatter->>'kind' = 'code'
          AND deleted_at IS NULL
          AND (source_path = $1 OR reverse(source_path) LIKE $2)
        LIMIT 1`;

export function codeRefLookupParams(path: string): [string, string] {
  return [path, `${escapeLike([...`/${path}`].reverse().join(""))}%`];
}

/**
 * Replace the doc→code (`type='documents'`, `link_kind='plain'`) edge set for
 * `sourceSlug` with one edge per cited code path that resolves to an INDEXED
 * code file. Deterministic, no LLM; idempotent DELETE-then-insert like the
 * wikilink sync.
 *
 * A code file lives in `documents` (`frontmatter.kind='code'`) keyed by an
 * absolute `source_path`, not in `pages` — so a cited repo-relative path
 * resolves by suffix match (`…/src/foo.ts`). Only a resolving citation becomes
 * an edge; an unindexed path is prose. The target is the cited path itself
 * (free text — code is addressed by path, not by slug). No reverse
 * `documented_by`: that edge would need the code file as `source_slug`, which
 * is FK-bound to `pages` and cannot hold a code-document identifier.
 */
export async function syncCodeRefsForPage(
  storage: Storage,
  sourceSlug: string,
  body: string,
  sourceId?: string,
): Promise<{ removed: number; added: number }> {
  validateSlug(sourceSlug);
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  const engine = storage.engine();

  // Keep only citations that point at an existing indexed code file. The lookup
  // is deliberately whole-brain: `documents.source_id` is a path-prefix
  // classification axis (repo / vault / memory), NOT the page's tenant source —
  // a note in the `default` page source routinely documents code carrying a
  // `repo` document source, so scoping this by the page's source_id would drop
  // essentially every real citation. Tenancy on the resulting EDGE is still
  // enforced: the links row is stamped with the page's source_id below.
  const resolved: string[] = [];
  for (const ref of extractCodeRefs(body)) {
    const hit = await engine.query<{ one: number }>(CODE_REF_LOOKUP_SQL, codeRefLookupParams(ref.path));
    if (hit.rows.length > 0) resolved.push(ref.path);
  }

  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $3" : "";
  return engine.transaction(async (tx) => {
    const delParams: unknown[] = [sourceSlug];
    if (scope !== null) delParams.push(scope);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND type = 'documents' AND link_kind = 'plain'${delScope}
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const target of resolved) {
      const insParams: unknown[] = [sourceSlug, target];
      if (scope !== null) insParams.push(scope);
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence, link_kind,
            link_source${insCol})
         VALUES ($1, $2, 'documents', 1.0, 'plain', 'markdown'${insVal})
         ON CONFLICT (source_slug, target_slug, type, source_id, link_source) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        insParams,
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}

// --- Link-extraction freshness watermark (migration 051) ------------------

/**
 * The link-extractor version stamp. A page whose `links_extracted_at` predates
 * this is STALE — re-extracting it would apply newer extractor logic. BUMP THIS
 * to the ship date whenever the link-extraction logic (the wikilink scanner,
 * gazetteer, typed-NER or verb rules) changes in a way that should re-run over
 * the whole corpus.
 *
 * The effective watermark is the later of this and the time the extractor
 * switches last changed (link-watermark.ts). Stale pages are re-extracted by
 * the capped `links-stale` cycle phase and by `memrain extract --stale`
 * (links-stale-sweep.ts); a page write re-extracts its own page inline.
 */
export const LINK_EXTRACTOR_VERSION_TS = "2026-10-10T00:00:00Z";

/**
 * Stamp a page as freshly link-extracted. Called AFTER the full link-sync set
 * (wikilinks + gazetteer mentions + typed-NER) completes for a put/append/
 * revert, so the watermark advances past the page's own `updated_at` and the
 * staleness predicate reads clean until the next edit or a version bump.
 *
 * Keyed on slug AND (when given) source_id. `slug` is the global PK today, so
 * the source filter is redundant now — it pre-empts the migration-047 composite
 * `(source_id, slug)` PK, under which a slug is no longer globally unique and a
 * source-blind UPDATE would over-stamp a sibling source's row.
 */
export async function stampLinksExtracted(engine: Engine, slug: string, sourceId?: string): Promise<void> {
  const params: unknown[] = [slug];
  let scopeFilter = "";
  if (typeof sourceId === "string" && sourceId.length > 0) {
    params.push(sourceId);
    scopeFilter = ` AND source_id = $${params.length}`;
  }
  await engine.query(`UPDATE pages SET links_extracted_at = NOW() WHERE slug = $1${scopeFilter}`, params);
}

export interface StaleExtractionOpts {
  /** Tenant scope: count only pages in these sources. Unscoped when omitted. */
  sourceIds?: string[];
  /** The code version watermark (default LINK_EXTRACTOR_VERSION_TS). The
   *  extractor switches' generation (link-watermark.ts) lifts it in SQL. */
  versionTs?: string;
}

/**
 * Count live pages whose link edges are stale for extraction — never extracted,
 * extracted under an older extractor version, or edited since the last extract.
 * Single engine.query, no postgres/pglite branch.
 */
export async function countStalePagesForExtraction(
  engine: Engine,
  opts: StaleExtractionOpts = {},
): Promise<number> {
  const versionTs = opts.versionTs ?? LINK_EXTRACTOR_VERSION_TS;
  const params: unknown[] = [versionTs];
  const scopeFilter = andSourceScope("source_id", opts.sourceIds, params);
  const r = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pages
      WHERE deleted_at IS NULL${scopeFilter}
        AND (links_extracted_at IS NULL
             OR links_extracted_at < ${linkWatermarkSql("$1")}
             OR updated_at > links_extracted_at)`,
    params,
  );
  return r.rows[0]?.n ?? 0;
}

/** One stale page's content, enough to re-run the full link-sync set. */
export interface StalePageRow {
  slug: string;
  type: string;
  markdown_body: string;
  compiled_truth: Record<string, unknown> | null;
  source_id: string;
  /**
   * Full-µs UTC string of `updated_at` (projected via `to_char`, not
   * `::text`/JS Date — both are DateStyle- or ms-truncation-fragile). The sweep
   * stamps `links_extracted_at` to exactly this so the staleness predicate
   * clears; a concurrent edit advancing `updated_at` past it keeps the page
   * stale for the next run (D4 race fix).
   */
  updated_at_iso: string;
}

export interface ListStaleExtractionOpts extends StaleExtractionOpts {
  /** Keyset page size (the only memory bound — page content is unbounded). */
  batchSize: number;
  /** Keyset cursor: return only pages with `slug > afterSlug`. */
  afterSlug?: string;
}

/**
 * One keyset batch of live pages whose link edges are stale for extraction.
 * Keysets on the `slug` PK. Single engine.query, no postgres/pglite branch.
 */
export async function listStalePagesForExtraction(
  engine: Engine,
  opts: ListStaleExtractionOpts,
): Promise<StalePageRow[]> {
  const versionTs = opts.versionTs ?? LINK_EXTRACTOR_VERSION_TS;
  const params: unknown[] = [versionTs];
  const scopeFilter = andSourceScope("source_id", opts.sourceIds, params);
  let afterClause = "";
  if (typeof opts.afterSlug === "string" && opts.afterSlug.length > 0) {
    params.push(opts.afterSlug);
    afterClause = ` AND slug > $${params.length}`;
  }
  params.push(opts.batchSize);
  const limitIdx = params.length;
  const r = await engine.query<StalePageRow>(
    `SELECT slug, type, markdown_body, compiled_truth, source_id,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM pages
      WHERE deleted_at IS NULL${scopeFilter}
        AND (links_extracted_at IS NULL
             OR links_extracted_at < ${linkWatermarkSql("$1")}
             OR updated_at > links_extracted_at)${afterClause}
      ORDER BY slug
      LIMIT $${limitIdx}`,
    params,
  );
  return r.rows;
}

/** A page processed by the sweep, stamped with its own read `updated_at_iso`. */
export interface ExtractedPageRef {
  slug: string;
  source_id: string;
  /** Stamp this exact value (the row's read updated_at); see {@link StalePageRow}. */
  extractedAt?: string;
}

/**
 * Batch-stamp `links_extracted_at` for swept pages. Per-ref timestamp (D4 race
 * fix): each ref carries the row's read `updated_at`; refs that omit it fall
 * back to `defaultExtractedAt`. 3-arg `unnest` (PGLite-proven, cf. synthesis
 * atoms/takes), keyed on `(slug, source_id)` to pre-empt the mig-047 composite
 * PK.
 *
 * `floorTs`: the base staleness predicate has only the NULL + `updated_at >`
 * arms, so it would stamp the raw read `updated_at`. memrain added a THIRD arm —
 * `links_extracted_at < versionTs` (the version-bump trigger, v1.26.0) — so
 * stamping a raw `updated_at` that predates the version would leave the version
 * arm true and the page stale forever. `floorTs` (=
 * {@link LINK_EXTRACTOR_VERSION_TS}, raised to the switches' generation in
 * SQL) lifts the stamp to `GREATEST(read
 * updated_at, versionTs)`: clears all three arms, yet a later edit advancing
 * `updated_at` past the floor re-stales the page (D4 preserved).
 */
export async function markPagesExtractedBatch(
  engine: Engine,
  refs: ExtractedPageRef[],
  defaultExtractedAt: string,
  floorTs?: string,
): Promise<void> {
  if (refs.length === 0) return;
  const slugs = refs.map((r) => r.slug);
  const srcs = refs.map((r) => r.source_id);
  const tss = refs.map((r) => r.extractedAt ?? defaultExtractedAt);
  const params: unknown[] = [slugs, srcs, tss];
  let tsExpr = "v.ts::timestamptz";
  if (typeof floorTs === "string" && floorTs.length > 0) {
    params.push(floorTs);
    tsExpr = `GREATEST(v.ts::timestamptz, ${linkWatermarkSql(`$${params.length}`)})`;
  }
  await engine.query(
    `UPDATE pages p SET links_extracted_at = ${tsExpr}
       FROM unnest($1::text[], $2::text[], $3::text[]) AS v(slug, source_id, ts)
      WHERE p.slug = v.slug AND p.source_id = v.source_id`,
    params,
  );
}
