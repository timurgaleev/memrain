/**
 * Relational recall — a deterministic relational-query arm (LLM-free).
 *
 * Some questions are answered by an EDGE between entities, not by a passage:
 * "who founded acme", "where does alice work", "what connects bob and carol".
 * Lexical / vector search surfaces those poorly because the answer lives in the
 * typed-link graph, not in any single chunk. This module turns such a query
 * into edge-derived candidate slugs by:
 *
 *   1. parsing a relational intent + extracting the seed entity + relation
 *      (regex/keyword only — see {@link parseRelationalQuery}, NO LLM);
 *   2. resolving the seed phrase to a real page slug via the same 4-stage
 *      canonicalizer the wikilink scanner uses ({@link makeSlugResolver});
 *   3. fanning out the matched typed edges over the `links` table
 *      ({@link graphNeighbors} for depth 1, {@link traverseGraph} for the
 *      type-agnostic `connects` walk).
 *
 * Determinism + safety. Detection parses the ORIGINAL query (never an
 * LLM-expanded variant). Seed resolution is gated: a phrase that only
 * slugify-falls-back (no real page) is dropped, so the arm never traverses
 * from an invented slug. Fail-OPEN: any error returns an empty list — this is
 * a standalone, additive MCP read tool (`relational_recall`), wired OUTSIDE
 * the hybridSearch hot path, so a fault here can never break search.
 *
 * Scope (v1, deliberate). Single-source, single-seed for the typed archetypes;
 * `connects` resolves two seeds and intersects their reachable sets. memrain has
 * no `introduced`/`knows`-style edge for "who introduced me to X", so that
 * archetype walks type-agnostically (any edge touching the seed is the signal).
 *
 * Tested in tests/relational_recall.test.ts.
 */
import { pageRowFilterClauses, type PageFilters } from "./filters.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
import type { Storage } from "../storage.ts";
import { KNOWN_LINK_TYPES, graphNeighbors, traverseGraph } from "../links.ts";
import { makeSlugResolver } from "../slug-canonicalize.ts";
import { visibilityClause } from "../visibility.ts";
import { andSourceScope } from "../source-scope.ts";

export type RelationalKind = "who_rel" | "who_at" | "connects" | "intro";
export type RelationalDirection = "outbound" | "inbound" | "both";

export interface RelationalQuery {
  /** Which archetype matched. */
  kind: RelationalKind;
  /** Raw entity phrases to resolve, in query order. 1 for most, 2 for connects. */
  seeds: string[];
  /** Typed edges to traverse, or null for a type-agnostic walk. */
  linkTypes: string[] | null;
  /** Traversal direction from the seed over the link graph. */
  direction: RelationalDirection;
  /** The matched relation phrase, for telemetry / debugging. */
  relationPhrase: string;
}

export interface RelationalRecallResult {
  /** A page slug reachable from the seed over the matched relation. */
  slug: string;
  /** The link type that surfaced this slug, or "connects" for the walk. */
  relation: string;
  /** Hop distance from the seed (1 for the typed single-hop archetypes). */
  depth: number;
}

export interface RelationalRecallOptions {
  filters?: PageFilters;
  /** Max candidates returned (1..200). Default 20. */
  limit?: number;
  /** Max hops for the type-agnostic `connects`/`intro` walk (1..6). Default 3. */
  depth?: number;
  /** Tenant scope: restrict edge fanout to these source_ids. `undefined` => unscoped; `[]` => nothing. */
  sourceIds?: string[];
  /** Receives the parsed intent + outcome for telemetry. Never throws upstream. */
  onMeta?: (meta: RelationalRecallMeta) => void;
}

export interface RelationalRecallMeta {
  /** True when the parse matched AND at least one candidate was found. */
  fired: boolean;
  /** The matched archetype, or null when the query isn't relational. */
  kind: RelationalKind | null;
  /** How many seeds resolved to a real page. */
  seeds_resolved: number;
  /** Candidate slugs returned. */
  candidates: number;
  /** True when fanout threw and the arm failed open. */
  errored: boolean;
}

// Bounded lazy seed capture: 1–80 chars, so the trailing anchor — not
// backtracking — decides the boundary (no catastrophic-backtracking surface).
const SEED = "(.{1,80}?)";

// Pronouns / generic nouns are never entities — reject a parse that cleans
// down to one of these (precision-first).
const STOPWORD_SEEDS: ReadonlySet<string> = new Set([
  "it", "that", "this", "them", "these", "those", "here", "there",
  "everyone", "anyone", "someone", "anybody", "somebody", "people",
  "things", "us", "me", "him", "her", "you", "who", "what", "which",
]);

interface CompiledPattern {
  re: RegExp;
  kind: RelationalKind;
  linkTypes: string[] | null;
  direction: RelationalDirection;
  seedGroups: 1 | 2;
}

// "who <verb> <seed>" — traverse INBOUND to the seed (the people who did the
// verb point AT the seed). Every emitted link type is in memrain's
// KNOWN_LINK_TYPES so a relation phrase can never name an edge ingest can't
// produce; `assertKnown` enforces that at module load.
const WHO_REL_VERBS: Array<{
  verb: string;
  linkTypes: string[];
  direction: RelationalDirection;
}> = [
  { verb: "invested in|invests in|funded|backed|backs", linkTypes: ["invested_in"], direction: "inbound" },
  { verb: "founded|co-?founded|started", linkTypes: ["founded"], direction: "inbound" },
  { verb: "advises|advised", linkTypes: ["advises"], direction: "inbound" },
  { verb: "works at|worked at|works for", linkTypes: ["works_at"], direction: "inbound" },
  { verb: "attended", linkTypes: ["attended"], direction: "inbound" },
  { verb: "knows|met", linkTypes: ["knows", "met"], direction: "both" },
];

/** Every link type a pattern emits must be one ingest can write. Fail loud at
 *  load time rather than silently traversing an edge that never exists. */
function assertKnown(types: string[]): string[] {
  const known = new Set<string>(KNOWN_LINK_TYPES);
  for (const t of types) {
    if (!known.has(t)) {
      throw new Error(
        `relational-recall: unknown link_type "${t}" — must be one of ${KNOWN_LINK_TYPES.join(", ")}`,
      );
    }
  }
  return types;
}

/**
 * On the cost of the patterns below, and why they are left as they are.
 *
 * Every `\s+` next to a SEED can trade characters with it — `.` accepts a
 * space — so inside one call these do backtrack super-linearly. What they
 * cannot do is grow: the only caller, {@link parseRelationalQuery}, rejects a
 * query over 512 chars before any pattern runs, and SEED caps a capture at 80.
 *
 * Measured through parseRelationalQuery over 31 attack shapes, worst first:
 * `who at ` + a 505-char whitespace run = 29.3 ms; `how are a and ` + run =
 * 16.5 ms; `what connects ` + run = 8.6 ms; `where does ` + run = 7.0 ms. From
 * 64 to 512 chars that worst shape grows 9.5x, 6.3x, 5.0x per doubling. The
 * 29 ms is a ceiling and not a sample: the same input at 1 K, 4 K, 16 K and
 * 64 K chars returns null in 0.000 ms, because the length gate fires first.
 *
 * So the bound is already in place, one frame up, and a 512-char query is the
 * most expensive one that exists. Narrowing the whitespace classes to remove
 * the backtracking would change which phrasings parse into a seed, on an arm
 * whose whole job is deciding that — not a trade worth 29 ms. This is also a
 * standalone MCP read tool, wired off the hybridSearch hot path (see the
 * module header), so the cost is paid once per explicit `relational_recall`
 * call, not once per search.
 */
function buildPatterns(): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];

  // connects — two seeds, type-agnostic. Most specific, checked first.
  patterns.push({
    re: new RegExp(
      // Bounded by the 512-char gate in parseRelationalQuery — 8.6 ms worst.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      `\\b(?:what|which)\\s+(?:companies?|people|things|entities|deals?)?\\s*(?:connects?|links?|ties? together|is (?:the )?(?:connection|link|relationship) between)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s*\\??$`,
      "i",
    ),
    kind: "connects", linkTypes: null, direction: "both", seedGroups: 2,
  });
  patterns.push({
    re: new RegExp(
      // Bounded by the 512-char gate in parseRelationalQuery — 16.5 ms worst.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      `\\bhow\\s+(?:are|is|do|does)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s+(?:connected|related|linked|associated)\\b`,
      "i",
    ),
    kind: "connects", linkTypes: null, direction: "both", seedGroups: 2,
  });

  // intro — type-agnostic walk around the named person (no `introduced` edge).
  patterns.push({
    re: new RegExp(
      // Bounded by the 512-char gate in parseRelationalQuery — 0.001 ms worst.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      `\\bwho\\s+(?:introduced|connected|referred)\\s+(?:me|us|him|her|them)\\s+to\\s+${SEED}\\s*\\??$`,
      "i",
    ),
    kind: "intro", linkTypes: null, direction: "both", seedGroups: 1,
  });

  // who_at — entity in the middle: "who at acme works on payments".
  patterns.push({
    re: new RegExp(
      // Bounded by the 512-char gate in parseRelationalQuery — 29.3 ms, the
      // worst of the 31 shapes measured, and the ceiling for the whole file.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      `\\bwho\\s+(?:at|from|in)\\s+${SEED}\\s+(?:works? on|works?|leads?|runs?|builds?|owns?|handles?|manages?)\\b`,
      "i",
    ),
    kind: "who_at", linkTypes: assertKnown(["works_at"]), direction: "inbound", seedGroups: 1,
  });

  // who_rel — "who <verb> <seed>".
  for (const v of WHO_REL_VERBS) {
    patterns.push({
      re: new RegExp(`\\bwho\\s+(?:${v.verb})\\s+${SEED}\\s*\\??$`, "i"),
      kind: "who_rel", linkTypes: assertKnown(v.linkTypes), direction: v.direction, seedGroups: 1,
    });
  }

  // outgoing variants — "what did <seed> invest in", "where does <seed> work".
  patterns.push({
    re: new RegExp(
      // Bounded by the 512-char gate in parseRelationalQuery — 6.7 ms worst.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      `\\bwhat\\s+(?:companies?|startups?|deals?)?\\s*(?:has|have|did|does)?\\s*${SEED}\\s+invest(?:ed)? in\\b`,
      "i",
    ),
    kind: "who_rel", linkTypes: assertKnown(["invested_in"]), direction: "outbound", seedGroups: 1,
  });
  patterns.push({
    // Bounded by the 512-char gate in parseRelationalQuery — 7.0 ms worst.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    re: new RegExp(`\\bwhere\\s+(?:does|did|has)\\s+${SEED}\\s+work\\b`, "i"),
    kind: "who_rel", linkTypes: assertKnown(["works_at"]), direction: "outbound", seedGroups: 1,
  });

  return patterns;
}

// Patterns are static — compile once at module load (and surface a bad
// link_type immediately rather than on first call).
const PATTERNS = buildPatterns();

/** Trim, drop a leading article + surrounding quotes, strip a trailing `?`. */
function cleanSeed(raw: string): string {
  return raw
    .trim()
    // Measured linear through parseRelationalQuery: 0.001 ms at the 512-char
    // cap, ratio 1.7 on a doubling to it. `raw` is a SEED capture, and SEED is
    // `(.{1,80}?)` — the `?` run this walks can never exceed 80 characters.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/\?+$/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
}

function validSeed(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false;
  if (STOPWORD_SEEDS.has(s.toLowerCase())) return false;
  return true;
}

/**
 * Parse a query into a {@link RelationalQuery}, or null if it isn't relational.
 * Pure: no DB, no LLM, no async. First matching pattern wins (ordered specific
 * → general). Bounds work at 512 chars (real queries are short).
 */
export function parseRelationalQuery(query: string): RelationalQuery | null {
  if (typeof query !== "string" || query.length === 0 || query.length > 512) {
    return null;
  }
  for (const p of PATTERNS) {
    const m = p.re.exec(query);
    if (!m) continue;
    if (p.seedGroups === 2) {
      const a = cleanSeed(m[1] ?? "");
      const b = cleanSeed(m[2] ?? "");
      if (!validSeed(a) || !validSeed(b)) continue;
      return { kind: p.kind, seeds: [a, b], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
    }
    const seed = cleanSeed(m[1] ?? "");
    if (!validSeed(seed)) continue;
    return { kind: p.kind, seeds: [seed], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
  }
  return null;
}

/** Resolve a seed phrase to a REAL page slug, or null when it only
 *  slugify-falls-back (confidence gate: never traverse from an invented slug). */
async function resolveSeed(
  storage: Storage,
  phrase: string,
  sourceIds?: string[],
): Promise<string | null> {
  // sourceSlug "" excludes nothing from the candidate sets — we're resolving a
  // query seed, not a page's own outbound mention, so there is no self to skip.
  // The caller's read scope IS forwarded: without it the seed stage resolves
  // against the whole brain, so a scoped caller could confirm the existence of
  // another source's page (an existence oracle) even though the fanout that
  // follows is scoped and returns nothing.
  const resolver = makeSlugResolver(storage, "", {
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  });
  const r = await resolver.resolve(phrase);
  return r.resolved ? r.slug : null;
}

function clampLimit(v: number | undefined): number {
  return typeof v === "number" && v >= 1 && v <= 200 ? Math.floor(v) : 20;
}

function clampDepth(v: number | undefined): number {
  return typeof v === "number" && v >= 1 && v <= 6 ? Math.floor(v) : 3;
}

/** The "other end" of a neighbor row relative to the seed. */
function otherEnd(
  row: { source_slug: string; target_slug: string },
  seed: string,
): string {
  return row.source_slug === seed ? row.target_slug : row.source_slug;
}

export interface FanoutOptions {
  filters?: PageFilters;
  /** Max candidates returned (1..200). Default 20. */
  limit?: number;
  /** Max hops for the type-agnostic `connects`/`intro` walk (1..6). Default 3. */
  depth?: number;
  /** Tenant scope: restrict edge fanout to these source_ids. `undefined` => unscoped; `[]` => nothing. */
  sourceIds?: string[];
  /** Receives how many seeds resolved to a real page (telemetry). */
  onSeedsResolved?: (n: number) => void;
}

async function eligibleRelationalSlugs(storage: Storage, slugs: string[], opts: FanoutOptions): Promise<Set<string>> {
  if (!opts.filters?.types?.length && !opts.filters?.slugPrefix) return new Set(slugs);
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  const scope = andSourceScope("p.source_id", opts.sourceIds, params);
  const filter = pageRowFilterClauses(params, opts.filters);
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT p.slug FROM pages p WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL${scope}${filter}`, params,
  );
  return new Set(r.rows.map(r => r.slug));
}

/**
 * Run the deterministic edge fanout for an ALREADY-parsed relational query — the
 * shared core of both the regex arm ({@link relationalRecall}) and the paid-LLM
 * fallback arm (core/search/relational-llm.ts). Resolves each seed to a REAL
 * page slug (confidence gate: an unresolved seed yields an empty list), then
 * fans out the matched typed edges — or a type-agnostic walk when
 * `linkTypes === null` — over the `links` graph.
 *
 * Does NOT catch: the caller owns fail-open policy (both arms wrap this in a
 * try/catch that returns an empty arm on fault).
 */
export async function fanoutRelational(
  storage: Storage,
  parsed: RelationalQuery,
  opts: FanoutOptions = {},
): Promise<RelationalRecallResult[]> {
  const limit = clampLimit(opts.limit);
  const depth = clampDepth(opts.depth);
  const sourceIds = opts.sourceIds;

  // connects — resolve BOTH endpoints, then intersect their reachable sets
  // (the shared midpoints), ordered by combined hop distance.
  if (parsed.kind === "connects" && parsed.seeds.length === 2) {
    const a = await resolveSeed(storage, parsed.seeds[0]!, sourceIds);
    const b = await resolveSeed(storage, parsed.seeds[1]!, sourceIds);
    if (!a || !b) return [];
    opts.onSeedsResolved?.(2);
    const [fromA, fromB] = await Promise.all([
      traverseGraph(storage, a, { direction: "both", maxDepth: depth, limit: 1000, sourceIds }),
      traverseGraph(storage, b, { direction: "both", maxDepth: depth, limit: 1000, sourceIds }),
    ]);
    const depthB = new Map(fromB.map((h) => [h.slug, h.depth]));
    const endpoints = new Set([a, b]);
    const eligible = await eligibleRelationalSlugs(storage, fromA.map(h => h.slug), opts);
    return fromA
      .filter((h) => eligible.has(h.slug) && depthB.has(h.slug) && !endpoints.has(h.slug))
      .map((h) => ({ slug: h.slug, combined: h.depth + (depthB.get(h.slug) ?? 0) }))
      .sort((x, y) => x.combined - y.combined || x.slug.localeCompare(y.slug))
      .slice(0, limit)
      .map((x) => ({ slug: x.slug, relation: "connects", depth: x.combined }));
  }

  // Single-seed archetypes (who_rel / who_at / intro).
  const seedSlug = await resolveSeed(storage, parsed.seeds[0]!, sourceIds);
  if (!seedSlug) return [];
  opts.onSeedsResolved?.(1);

  // intro — no `introduced` edge in memrain; walk every edge touching the seed.
  if (parsed.linkTypes === null) {
    const hits = await traverseGraph(storage, seedSlug, {
      direction: parsed.direction,
      maxDepth: depth,
      limit: opts.filters?.types?.length || opts.filters?.slugPrefix ? 1000 : limit,
      sourceIds,
    });
    const eligible = await eligibleRelationalSlugs(storage, hits.map(h => h.slug), opts);
    return hits.filter(h => eligible.has(h.slug)).slice(0, limit).map((h) => ({ slug: h.slug, relation: "related_to", depth: h.depth }));
  }

  // Typed single-hop: union the matched link types, dedup by the other-end
  // slug (a slug surfaced by two types keeps its first relation), cap at limit.
  const wantedTypes = new Set(parsed.linkTypes);
  const seen = new Map<string, RelationalRecallResult>();
  for (const lt of parsed.linkTypes) {
    const rows = await graphNeighbors(storage, seedSlug, {
      type: lt,
      direction: parsed.direction,
      limit: 1000,
      sourceIds,
    });
    const eligible = await eligibleRelationalSlugs(storage, rows.map(row => otherEnd(row, seedSlug)), opts);
    for (const row of rows) {
      if (!wantedTypes.has(row.type)) continue; // defensive: type filter is exact
      const slug = otherEnd(row, seedSlug);
      if (slug === seedSlug || seen.has(slug) || !eligible.has(slug)) continue;
      seen.set(slug, { slug, relation: row.type, depth: 1 });
      if (seen.size >= limit) break;
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * Build the relational recall arm. Returns an empty list (a pure no-op) when
 * the query isn't relational, no seed resolves, or fanout fails. Never throws.
 */
export async function relationalRecall(
  storage: Storage,
  query: string,
  opts: RelationalRecallOptions = {},
): Promise<RelationalRecallResult[]> {
  const meta: RelationalRecallMeta = {
    fired: false, kind: null, seeds_resolved: 0, candidates: 0, errored: false,
  };
  const finish = (list: RelationalRecallResult[]) => {
    meta.candidates = list.length;
    meta.fired = list.length > 0;
    opts.onMeta?.(meta);
    return list;
  };

  const parsed = parseRelationalQuery(query);
  if (!parsed) return finish([]);
  meta.kind = parsed.kind;

  try {
    const list = await fanoutRelational(storage, parsed, {
      limit: opts.limit,
      depth: opts.depth,
      sourceIds: opts.sourceIds,
      filters: opts.filters,
      onSeedsResolved: (n) => {
        meta.seeds_resolved = n;
      },
    });
    return finish(list);
  } catch (err) {
    // Fail-open: a fanout fault returns an empty arm, never breaking the caller.
    console.error(
      "[relational-recall] fanout failed, returning empty arm:",
      err instanceof Error ? err.message : err,
    );
    meta.errored = true;
    return finish([]);
  }
}

/**
 * Resolve a relational-recall run into a ranked list of CHUNK IDs, ready to fuse
 * as a fourth RRF arm inside hybridSearch. Each edge-derived page slug maps to
 * its page's HEAD chunk (lowest chunk id) via the source-qualified mirror — the
 * same representative chunk `applyAliasHop` injects — so a typed-edge answer
 * competes in the same candidate space as the keyword/vector arms.
 *
 * Order-preserving: chunk ids come back in relational (ranked) order, so the
 * arm's RRF rank reflects hop distance / relation strength. Pages with no live
 * indexed chunk in scope (chunkless entity pages, or a page not mirrored into
 * search) are silently skipped. Fail-open: a resolution error yields an empty
 * arm, never breaking search. Scoped by `sourceIds` (tenant isolation) and the
 * document visibility filter (never surface a hidden page).
 */
export async function relationalArmChunkIds(
  storage: Storage,
  query: string,
  opts: RelationalRecallOptions = {},
): Promise<string[]> {
  const results = await relationalRecall(storage, query, opts);
  if (results.length === 0) return [];

  // De-dup the ordered slugs (keep first occurrence) → one page:chunk per slug.
  const slugOrder: string[] = [];
  const seenSlug = new Set<string>();
  for (const r of results) {
    if (seenSlug.has(r.slug)) continue;
    seenSlug.add(r.slug);
    slugOrder.push(r.slug);
  }
  try {
    const engine = storage.engine();
    const params: unknown[] = [slugOrder];
    const scopeFilter = andSourceScope("d.source_id", opts.sourceIds, params);
    const pageFilter = pageRowFilterClauses(params, opts.filters);
    // Head chunk (lowest id) per page, matching fetchPageHeadHit's choice.
    // Legacy unowned mirrors belong to default pages on the unscoped path;
    // the document source predicate still excludes NULL from every tenant grant.
    const rows = await engine.query<{ id: string; slug: string }>(
      `SELECT DISTINCT ON (p.slug) c.id, p.slug
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN pages p ON p.source_id = COALESCE(d.source_id, 'default') AND d.source_path = (${PAGE_MIRROR_PATH_SQL})
        WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL${scopeFilter}${pageFilter}
          AND ${visibilityClause("d")}
        ORDER BY p.slug, c.id COLLATE "C" ASC`,
      params,
    );
    const chunkBySlug = new Map(rows.rows.map((r) => [r.slug, r.id]));
    const out: string[] = [];
    for (const slug of slugOrder) {
      const id = chunkBySlug.get(slug);
      if (id) out.push(id);
    }
    return out;
  } catch (err) {
    // Fail-open: a hydration fault drops the arm, never breaking search.
    console.error(
      "[relational-recall] chunk-id hydration failed, dropping arm:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
