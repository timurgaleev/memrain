/**
 * Graph-insight reads — deterministic, LLM-free hygiene + discovery queries
 * over the page/link/fact/timeline graph. All four answer "shape of the
 * knowledge base" questions a maintainer asks during an enrichment cycle:
 *
 *   - findOrphans       — pages with zero inbound links (enrichment targets).
 *   - findExperts       — pages ranked by graph link-degree (the hubs).
 *   - findContradictions — page pairs joined by an explicit `contradicts` edge.
 *   - findTrajectory    — chronological how-an-entity-changed log, merging the
 *                         entity_facts ledger with timeline_events.
 *
 * Each is a single SQL round-trip with $N placeholders and {rows} reads,
 * mirroring the existing links.ts / facts.ts query style. Soft-deleted pages
 * (`pages.deleted_at IS NOT NULL`) are excluded everywhere a page row is the
 * subject, so a deleted page never appears as an orphan/expert/contradiction.
 *
 * Tables: pages (015), links (016), timeline_events (017), entity_facts (018 +
 * 037 metadata). No schema change — all columns queried already exist.
 */
import { factSourceEligibleSql } from "./quarantine.ts";
import type { Storage } from "./storage.ts";
import { orphanExclusionSql } from "./orphan-policy.ts";
import { hybridSearch, type SearchHit, type SearchOptions } from "./search/hybrid.ts";
import { PAGE_MIRROR_PATH_SQL, isPageSourcePath } from "./page-index.ts";
import { normalizeScope } from "./source-scope.ts";

// Shared kebab-case slug grammar (matches links.ts / pages.ts — keep the three
// copies in sync). Word chars cover lowercase/caseless letters of any script
// plus marks and digits. Validated at
// the boundary so a caller-supplied slug can never be interpolated raw, and a
// malformed value fails fast with a clear message rather than an empty result.
const SLUG_WORD = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}]";
const SLUG_WORD_OR_DASH = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}-]";
const SLUG_RE = new RegExp(
  `^${SLUG_WORD}${SLUG_WORD_OR_DASH}*(?:\\/${SLUG_WORD}${SLUG_WORD_OR_DASH}*)*$`,
  "u",
);
const MAX_SLUG_LEN = 256;

function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `slug must match kebab-case with optional / namespaces (got ${JSON.stringify(slug)})`,
    );
  }
}

/** Clamp an optional caller limit into [1, max], default `def`. */
function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (typeof limit === "number" && limit >= 1 && limit <= max) {
    return Math.floor(limit);
  }
  return def;
}

// --- find_orphans ----------------------------------------------------------

export interface FindOrphansOptions {
  /** Restrict to a single page `type` (e.g. "person"). */
  type?: string;
  /** Max rows (1..1000, default 50). */
  limit?: number;
  /**
   * Tenant scope. `undefined` → unscoped (all sources); `[]` → nothing.
   * Non-empty → only pages whose `source_id` is in the list.
   */
  sourceIds?: string[];
}

export interface OrphanRow {
  slug: string;
  type: string;
  title: string | null;
  updated_at: string;
}

/**
 * Pages with zero inbound links — nothing in the graph references them. These
 * are the natural enrichment targets (a page nobody links to is either new or
 * forgotten). Soft-deleted pages are excluded. Newest-first so the freshest
 * unlinked pages surface at the top of an enrichment queue.
 */
export async function findOrphans(
  storage: Storage,
  opts: FindOrphansOptions = {},
): Promise<OrphanRow[]> {
  const limit = clampLimit(opts.limit, 50, 1000);
  const params: unknown[] = [];
  let typeFilter = "";
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findOrphans: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  }
  const sources = normalizeScope(opts.sourceIds);
  let sourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    sourceFilter = ` AND p.source_id = ANY($${params.length}::text[])`;
  }
  // Pages a brain writes to be islanded (synthesis output, drift reports) are
  // not findings — counting them is what turned this number into noise.
  const excl = orphanExclusionSql("p.slug", params.length + 1);
  params.push(...excl.params);
  params.push(limit);
  const r = await storage.engine().query<OrphanRow>(
    `SELECT p.slug, p.type, p.title, p.updated_at::text AS updated_at
       FROM pages p
       WHERE p.deleted_at IS NULL${typeFilter}${sourceFilter}${excl.sql}
         AND NOT EXISTS (
           SELECT 1 FROM links l WHERE l.target_slug = p.slug
         )
       ORDER BY p.updated_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

// --- find_experts ----------------------------------------------------------

export interface FindExpertsOptions {
  /** Restrict to a single page `type`. */
  type?: string;
  /** Max rows (1..200, default 5). */
  limit?: number;
  /**
   * Tenant scope. `undefined` → unscoped; `[]` → nothing. Non-empty →
   * rank only pages in the listed sources, counting only those sources' edges.
   */
  sourceIds?: string[];
  /**
   * Optional topic query. When present (non-empty), switches from the default
   * link-degree hub ranking to expertise ranking: person/company pages scored
   * by how strongly their body relates to the topic, decayed by relationship
   * recency and lifted by salience. Deterministic — no LLM.
   */
  topic?: string;
  /**
   * Test-only injection of the query embedder, threaded into `hybridSearch`
   * so the topic arm runs hermetically without Bedrock. Production leaves this
   * undefined and the real Titan embedder is used.
   */
  embedQuery?: (text: string) => Promise<number[]>;
  /**
   * Include the per-result factor breakdown (topic mode only): the raw
   * expertise / recency / salience components behind `score`. No cost — the
   * factors are already computed; this just surfaces them.
   */
  explain?: boolean;
}

export interface ExpertRow {
  slug: string;
  type: string;
  title: string | null;
  /** Distinct in+out neighbours that resolve to a live page (link-degree mode). */
  degree: number;
  /**
   * Composite expertise score (topic mode only): expertise × recency × salience.
   * Absent in link-degree mode, where `degree` is the ranking key.
   */
  score?: number;
  /** Factor breakdown behind `score` — present only with `explain` in topic mode. */
  factors?: { expertise: number; recency: number; salience: number };
}

// Expertise-ranking constants (topic mode). Mirrors the locked whoknows spec:
// score = expertise × max(floor, recency_decay) × (0.5 + 0.5 × salience).
const EXPERTISE_HALF_LIFE_DAYS = 180; // ~6-month relationship half-life
const EXPERTISE_RECENCY_FLOOR = 0.1; // cold pages stay visible (no multiplicative-zero)
// Default candidate types when no explicit `type` filter is passed — the
// person/company "who knows about X" surface. Any single `type` override wins.
const EXPERT_DEFAULT_TYPES = ["person", "company"];

/**
 * Pages ranked by graph link-degree — the hubs of the knowledge base. Degree
 * is distinct in+out neighbours, counting ONLY edges to existing, non-deleted
 * pages (same inflation-safe gating as the recompute-salience phase: a page
 * can't rank as an expert by listing many unresolved `[[wikilink]]` stubs).
 * Ties break on updated_at DESC so the ordering is deterministic.
 */
export async function findExperts(
  storage: Storage,
  opts: FindExpertsOptions = {},
): Promise<ExpertRow[]> {
  if (typeof opts.topic === "string" && opts.topic.trim().length > 0) {
    return findExpertsByTopic(storage, opts);
  }
  const limit = clampLimit(opts.limit, 5, 200);
  const params: unknown[] = [];
  let typeFilter = "";
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findExperts: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  }
  const sources = normalizeScope(opts.sourceIds);
  let edgeSourceFilter = "";
  let pageSourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    const idx = params.length;
    // Count only the tenant's own edges and rank only the tenant's pages.
    edgeSourceFilter = ` WHERE source_id = ANY($${idx}::text[])`;
    pageSourceFilter = ` AND p.source_id = ANY($${idx}::text[])`;
  }
  params.push(limit);
  const r = await storage.engine().query<{
    slug: string;
    type: string;
    title: string | null;
    degree: number | string;
  }>(
    `WITH edges AS (
       SELECT source_slug AS slug, target_slug AS neighbour FROM links${edgeSourceFilter}
       UNION ALL
       SELECT target_slug AS slug, source_slug AS neighbour FROM links${edgeSourceFilter}
     ),
     degrees AS (
       SELECT e.slug, COUNT(DISTINCT e.neighbour) AS degree
       FROM edges e
       JOIN pages np ON np.slug = e.neighbour AND np.deleted_at IS NULL
       GROUP BY e.slug
     )
     SELECT p.slug, p.type, p.title, COALESCE(d.degree, 0) AS degree
       FROM pages p
       LEFT JOIN degrees d ON d.slug = p.slug
       WHERE p.deleted_at IS NULL${typeFilter}${pageSourceFilter}
       ORDER BY COALESCE(d.degree, 0) DESC, p.updated_at DESC, p.slug COLLATE "C" ASC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    type: row.type,
    title: row.title,
    degree: Number(row.degree) || 0,
  }));
}

/**
 * Topic-ranked experts — "who in my brain knows about <topic>?". Person/company
 * pages ranked by expertise depth, not raw graph connectivity. Deterministic:
 * the topic signal is memrain's own hybrid search over the page → search mirror
 * (`page://<slug>` documents, see page-index.ts), so a page whose body relates
 * to the topic scores high with NO LLM call.
 *
 *   score = expertise × max(floor, recency_decay) × (0.5 + 0.5 × salience)
 *     expertise      = log1p(topic_match)  — sub-linear; one big page can't dominate.
 *     recency_decay  = exp(-days_since_updated / 180), floored at 0.1.
 *     salience       = pages.salience (already 0..1), centered so missing = neutral.
 *
 * Tenant scope is threaded into the search AND the page resolve so a scoped
 * caller never surfaces another source's people. Defaults to person/company
 * candidates; an explicit `type` overrides that.
 */
async function findExpertsByTopic(
  storage: Storage,
  opts: FindExpertsOptions,
): Promise<ExpertRow[]> {
  const topic = (opts.topic ?? "").trim();
  const limit = clampLimit(opts.limit, 5, 200);
  const sources = normalizeScope(opts.sourceIds);

  // 1. Topic match. Widen the candidate pool (×10, floor 50) so a page's best
  //    chunk score survives chunk-grain fan-out before we collapse to pages.
  const innerK = Math.max(limit * 10, 50);
  // Keep the topic signal deterministic + free (the doc contract above): pin the
  // intent so hybridSearch skips its per-query Haiku intent classifier, disable
  // query expansion (another Haiku call), and drop the backlink boost so ranking
  // reflects topic match, not hub popularity.
  const searchOpts: SearchOptions = {
    k: innerK,
    intent: "topic",
    noExpansion: true,
    backlinkBoost: false,
  };
  if (sources !== undefined) searchOpts.sourceIds = sources;
  if (opts.embedQuery) searchOpts.embedQuery = opts.embedQuery;
  let hits: SearchHit[];
  try {
    hits = await hybridSearch(storage, topic, searchOpts);
  } catch {
    // A search failure (e.g. embed deadline with no keyword hits) yields no
    // experts rather than throwing — the caller asked a question, not a write.
    return [];
  }

  // 2. Collapse chunk hits to one best score per page-mirror document.
  const bestByPath = new Map<string, number>();
  for (const h of hits) {
    if (!isPageSourcePath(h.sourcePath)) continue;
    const prev = bestByPath.get(h.sourcePath);
    if (prev === undefined || h.score > prev) bestByPath.set(h.sourcePath, h.score);
  }
  if (bestByPath.size === 0) return [];

  // 3. Resolve mirror paths back to live person/company pages, tenant-scoped.
  //    Joining on the mirror-path EXPRESSION (not a parse of source_path) is
  //    unambiguous even when a slug itself contains '/'.
  const paths = Array.from(bestByPath.keys());
  const params: unknown[] = [paths];
  let typeFilter: string;
  if (opts.type !== undefined) {
    if (typeof opts.type !== "string" || opts.type.length === 0) {
      throw new Error("findExperts: type must be a non-empty string");
    }
    params.push(opts.type);
    typeFilter = ` AND p.type = $${params.length}`;
  } else {
    params.push(EXPERT_DEFAULT_TYPES);
    typeFilter = ` AND p.type = ANY($${params.length}::text[])`;
  }
  let pageSourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    pageSourceFilter = ` AND p.source_id = ANY($${params.length}::text[])`;
  }
  const rows = await storage.engine().query<{
    slug: string;
    type: string;
    title: string | null;
    salience: number | string;
    updated_at: string;
    mirror_path: string;
  }>(
    `SELECT p.slug, p.type, p.title, p.salience,
            p.updated_at::text AS updated_at,
            ${PAGE_MIRROR_PATH_SQL} AS mirror_path
       FROM pages p
       WHERE p.deleted_at IS NULL${typeFilter}${pageSourceFilter}
         AND ${PAGE_MIRROR_PATH_SQL} = ANY($1::text[])`,
    params,
  );

  // 4. Score each resolved page.
  const now = Date.now();
  const scored: ExpertRow[] = rows.rows.map((row) => {
    const raw = bestByPath.get(row.mirror_path) ?? 0;
    const expertise = Math.log1p(Math.max(0, Number.isFinite(raw) ? raw : 0));

    let recency = EXPERTISE_RECENCY_FLOOR;
    const updatedMs = Date.parse(row.updated_at);
    if (Number.isFinite(updatedMs)) {
      const days = Math.max(0, (now - updatedMs) / 86_400_000);
      recency = Math.max(EXPERTISE_RECENCY_FLOOR, Math.exp(-days / EXPERTISE_HALF_LIFE_DAYS));
    }

    let salience = Number(row.salience);
    if (!Number.isFinite(salience)) salience = 0;
    salience = Math.min(1, Math.max(0, salience));
    const salienceFactor = 0.5 + 0.5 * salience;

    const score = expertise * recency * salienceFactor;
    const out: ExpertRow = {
      slug: row.slug,
      type: row.type,
      title: row.title,
      degree: 0,
      score: Number.isFinite(score) ? score : 0,
    };
    if (opts.explain === true) {
      out.factors = {
        expertise: Number(expertise.toFixed(6)),
        recency: Number(recency.toFixed(6)),
        salience: Number(salienceFactor.toFixed(6)),
      };
    }
    return out;
  });

  // 5. Rank by score DESC; tie-break on slug for a deterministic order.
  scored.sort((a, b) => {
    const sb = b.score ?? 0;
    const sa = a.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return scored.slice(0, limit);
}

// --- find_contradictions ---------------------------------------------------

export interface FindContradictionsOptions {
  /** Substring filter; matches either side of the pair (case-insensitive). */
  slug?: string;
  /** Max rows (1..200, default 20). */
  limit?: number;
  /**
   * Tenant scope. `undefined` → unscoped; `[]` → nothing. Non-empty →
   * only `contradicts` edges whose `source_id` is in the list.
   */
  sourceIds?: string[];
}

export interface ContradictionRow {
  source_slug: string;
  target_slug: string;
  source_title: string | null;
  target_title: string | null;
  confidence: number;
  written_at: string;
}

/**
 * Page pairs joined by an explicit `contradicts` edge (links.type =
 * 'contradicts', migration 016). Deterministic — surfaces the conflict markers
 * already asserted in the graph; it does NOT run a fresh probe or call an LLM.
 * The source side is gated to a live page (FK + deleted_at); the target is a
 * soft reference, so its title is LEFT-joined and may be null when the target
 * page doesn't exist yet.
 */
export async function findContradictions(
  storage: Storage,
  opts: FindContradictionsOptions = {},
): Promise<ContradictionRow[]> {
  const limit = clampLimit(opts.limit, 20, 200);
  const params: unknown[] = [];
  let slugFilter = "";
  if (opts.slug !== undefined) {
    if (typeof opts.slug !== "string" || opts.slug.length === 0) {
      throw new Error("findContradictions: slug must be a non-empty string");
    }
    // Substring match on either side. ILIKE pattern is parameterised; escape
    // the LIKE metacharacters so a literal `%`/`_` in the filter can't widen it.
    const escaped = opts.slug.toLowerCase().replace(/[\\%_]/g, "\\$&");
    params.push(`%${escaped}%`);
    slugFilter = ` AND (l.source_slug ILIKE $${params.length} ESCAPE '\\' OR l.target_slug ILIKE $${params.length} ESCAPE '\\')`;
  }
  const sources = normalizeScope(opts.sourceIds);
  let sourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    sourceFilter = ` AND l.source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const r = await storage.engine().query<ContradictionRow>(
    `SELECT l.source_slug, l.target_slug,
            sp.title AS source_title, tp.title AS target_title,
            l.inferred_confidence AS confidence,
            l.written_at::text AS written_at
       FROM links l
       JOIN pages sp ON sp.slug = l.source_slug AND sp.deleted_at IS NULL
       LEFT JOIN pages tp ON tp.slug = l.target_slug AND tp.deleted_at IS NULL
       WHERE l.type = 'contradicts'${slugFilter}${sourceFilter}
       ORDER BY l.written_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    source_slug: row.source_slug,
    target_slug: row.target_slug,
    source_title: row.source_title,
    target_title: row.target_title,
    confidence: Number(row.confidence) || 0,
    written_at: row.written_at,
  }));
}

// --- probed (suspected) contradictions -------------------------------------

export interface ProbedContradictionRow {
  a_ref: string;
  a_text: string;
  b_ref: string;
  b_text: string;
  severity: string;
  axis: string;
  confidence: number;
  resolution_command: string;
  generated_at: string;
}

/**
 * LLM-suspected contradictions cached by the `probe-contradictions` phase
 * (migration 064) — the paid complement to the asserted `contradicts` edges
 * findContradictions reads. Highest severity + confidence first. Tenant-scoped
 * fail-closed when a read scope is supplied (a NULL/foreign source_id row is
 * excluded, matching migration 047). Database failures propagate to the caller.
 */
export async function listProbedContradictions(
  storage: Storage,
  opts: { limit?: number; sourceIds?: string[]; severity?: "low" | "medium" | "high" } = {},
): Promise<ProbedContradictionRow[]> {
  const limit = clampLimit(opts.limit, 20, 200);
  const params: unknown[] = [];
  const sources = normalizeScope(opts.sourceIds);
  let sourceFilter = "";
  if (sources !== undefined) {
    params.push(sources);
    sourceFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  if (opts.severity === "low" || opts.severity === "medium" || opts.severity === "high") {
    params.push(opts.severity);
    sourceFilter += ` AND severity = $${params.length}`;
  }
  params.push(limit);
  const r = await storage.engine().query<ProbedContradictionRow>(
    `SELECT a_ref, a_text, b_ref, b_text, severity, axis,
            confidence, resolution_command, generated_at::text AS generated_at
       FROM synth_contradictions
      WHERE 1 = 1${sourceFilter}
      ORDER BY
        CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
        confidence DESC,
        generated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    a_ref: row.a_ref,
    a_text: row.a_text,
    b_ref: row.b_ref,
    b_text: row.b_text,
    severity: row.severity,
    axis: row.axis,
    confidence: Number(row.confidence) || 0,
    resolution_command: row.resolution_command,
    generated_at: row.generated_at,
  }));
}

// --- find_trajectory -------------------------------------------------------

export interface FindTrajectoryOptions {
  /** Lower bound (ISO timestamp) on the point's effective date. */
  since?: string;
  /** Upper bound (ISO timestamp). */
  until?: string;
  /** Max points (1..500, default 100). */
  limit?: number;
  /**
   * Tenant scope. `undefined` → unscoped; `[]` → nothing. Non-empty →
   * only facts/events whose `source_id` is in the list.
   */
  sourceIds?: string[];
  /**
   * Metric filter (migration 070). When set, only entity_facts rows whose
   * `claim_metric` equals this canonical label participate; timeline_events are
   * excluded (a metric query is about typed fact claims). Normalized to the same
   * lowercase snake_case the writer stores.
   */
  metric?: string;
  /**
   * Typed-claim shape filter (migration 070). Default `all` preserves the
   * merged fact+event chronology.
   *   - `metric`: only fact rows with `claim_metric IS NOT NULL`; timeline
   *     events excluded.
   *   - `event`:  only fact rows with `event_type IS NOT NULL`, plus timeline
   *     events (both are "events").
   *   - `all`:    both fact + event arms (current default).
   */
  claimKind?: "metric" | "event" | "all";
  /**
   * Fetch each fact point's raw embedding (migration 038) so the caller can
   * compute a drift_score without a second round-trip. Default OFF — the plain
   * chronological trajectory never pays the payload cost. `findTrajectoryStats`
   * turns it on.
   */
  includeEmbedding?: boolean;
}

export interface TrajectoryPoint {
  /** "fact" (entity_facts ledger) or "event" (timeline_events). */
  source: "fact" | "event";
  /** ISO timestamp the point is anchored at (fact valid_from→written_at fallback; event occurred_at). */
  at: string;
  /** Free-text claim/event description. */
  text: string;
  /** Fact category (mig037 kind) or null for events / legacy facts. */
  kind: string | null;
  /** Underlying row id (entity_facts.id or timeline_events.id). */
  id: number;
  /** Canonical metric label (mig070); null for events / non-typed facts. */
  metric: string | null;
  /** Numeric claim value (mig070); null when the row carries no metric. */
  value: number | null;
  /** Free-form unit string (mig070); null when absent. */
  unit: string | null;
  /** Free-form period string (mig070); null when absent. */
  period: string | null;
  /** Event-shaped row marker (mig070); null when absent. */
  event_type: string | null;
  /**
   * Raw fact embedding for drift computation — only populated when
   * `includeEmbedding` is set; null for events, unembedded facts, or when the
   * option is off.
   */
  embedding: number[] | null;
}

/**
 * Chronological "how did this entity change?" log for one slug — the merged
 * view of its entity_facts ledger and its timeline_events, oldest-first so a
 * caller reads the entity's history top-to-bottom. Each fact is anchored at its
 * `valid_from` when set (when the claim became true) and falls back to
 * `written_at` (when it was recorded); each event at its `occurred_at`. Bounds
 * filter on that anchor date. No LLM — pure ledger merge.
 */
export async function findTrajectory(
  storage: Storage,
  entitySlug: string,
  opts: FindTrajectoryOptions = {},
): Promise<TrajectoryPoint[]> {
  validateSlug(entitySlug);
  const limit = clampLimit(opts.limit, 100, 500);
  const claimKind = opts.claimKind ?? "all";
  const metric = normalizeMetricFilter(opts.metric);
  // A metric query is about typed fact claims — the timeline_events arm carries
  // no metric, so it is dropped when a metric filter or `claimKind: 'metric'`
  // is in play. Otherwise both arms merge as before.
  const includeEvents = metric === undefined && claimKind !== "metric";
  const wantEmbedding = opts.includeEmbedding === true;
  // $1 = entity slug; the bound params are shared across both arms of the UNION.
  const params: unknown[] = [entitySlug];
  // Dimensional ontology rows (mig097) have their own read path (getOntology);
  // keep them out of the free-text fact-trajectory arm.
  let factBounds = ` AND f.dimension IS NULL AND ${factSourceEligibleSql("f")}`;
  let eventBounds = "";
  if (opts.since !== undefined) {
    if (typeof opts.since !== "string" || opts.since.length === 0) {
      throw new Error("findTrajectory: since must be a non-empty ISO string");
    }
    params.push(opts.since);
    const idx = params.length;
    factBounds += ` AND COALESCE(f.valid_from::timestamptz, f.written_at) >= $${idx}::timestamptz`;
    eventBounds += ` AND ev.occurred_at >= $${idx}::timestamptz`;
  }
  if (opts.until !== undefined) {
    if (typeof opts.until !== "string" || opts.until.length === 0) {
      throw new Error("findTrajectory: until must be a non-empty ISO string");
    }
    params.push(opts.until);
    const idx = params.length;
    factBounds += ` AND COALESCE(f.valid_from::timestamptz, f.written_at) <= $${idx}::timestamptz`;
    eventBounds += ` AND ev.occurred_at <= $${idx}::timestamptz`;
  }
  const sources = normalizeScope(opts.sourceIds);
  if (sources !== undefined) {
    params.push(sources);
    const idx = params.length;
    factBounds += ` AND f.source_id = ANY($${idx}::text[])`;
    eventBounds += ` AND ev.source_id = ANY($${idx}::text[])`;
  }
  if (metric !== undefined) {
    params.push(metric);
    factBounds += ` AND f.claim_metric = $${params.length}`;
  } else if (claimKind === "metric") {
    factBounds += ` AND f.claim_metric IS NOT NULL`;
  } else if (claimKind === "event") {
    factBounds += ` AND f.event_type IS NOT NULL`;
  }
  params.push(limit);
  const limitIdx = params.length;
  // The event arm must project the same columns as the fact arm so the UNION
  // type-checks; typed-claim columns are NULL for events. Embedding is fetched
  // only when asked (payload cost).
  const embSelectFact = wantEmbedding
    ? "f.embedding::text AS embedding"
    : "NULL::text AS embedding";
  const eventArm = includeEvents
    ? `
       UNION ALL
       SELECT 'event'::text AS source,
              ev.occurred_at::text AS at,
              ev.event AS text,
              NULL::text AS kind,
              ev.id AS id,
              NULL::text AS metric,
              NULL::numeric AS value,
              NULL::text AS unit,
              NULL::text AS period,
              NULL::text AS event_type,
              NULL::text AS embedding
         FROM timeline_events ev
         WHERE ev.slug = $1${eventBounds}
           AND (ev.event_slug IS NULL OR EXISTS (SELECT 1 FROM pages ep WHERE ep.slug = ev.event_slug AND ep.deleted_at IS NULL AND ep.source_id = ev.source_id))`
    : "";
  const r = await storage.engine().query<{
    source: "fact" | "event";
    at: string;
    text: string;
    kind: string | null;
    id: number | string;
    metric: string | null;
    value: number | string | null;
    unit: string | null;
    period: string | null;
    event_type: string | null;
    embedding: string | null;
  }>(
    `SELECT * FROM (
       SELECT 'fact'::text AS source,
              COALESCE(f.valid_from::timestamptz, f.written_at)::text AS at,
              f.fact AS text,
              f.kind AS kind,
              f.id AS id,
              f.claim_metric AS metric,
              f.claim_value AS value,
              f.claim_unit AS unit,
              f.claim_period AS period,
              f.event_type AS event_type,
              ${embSelectFact}
         FROM entity_facts f
         WHERE f.entity_slug = $1${factBounds}${eventArm}
     ) merged
     ORDER BY merged.at ASC, merged.source ASC, merged.id ASC
     LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map((row) => ({
    source: row.source,
    at: row.at,
    text: row.text,
    kind: row.kind,
    id: Number(row.id),
    metric: row.metric,
    value: row.value === null ? null : Number(row.value),
    unit: row.unit,
    period: row.period,
    event_type: row.event_type,
    embedding: wantEmbedding ? parseEmbedding(row.embedding) : null,
  }));
}

// --- metric-trajectory derived stats (mig070) ------------------------------
//
// Pure functions over `TrajectoryPoint[]` — regression detection + embedding
// drift_score over memrain's point shape (ISO-string `at`, `number[]`
// embeddings). The plain chronological `findTrajectory` stays the default;
// these are additive.

/** Default regression threshold — a 10% drop between consecutive metric values. */
export const DEFAULT_REGRESSION_THRESHOLD = 0.1;

/** Schema version for the trajectory-stats JSON contract. Additive-only. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

export interface TrajectoryRegression {
  metric: string;
  from_value: number;
  from_date: string; // YYYY-MM-DD
  to_value: number;
  to_date: string;
  delta_pct: number; // negative for a drop; typically in [-1, 0)
}

export interface TrajectoryStats {
  /** Every consecutive (metric, value) pair whose newer value dropped ≥ threshold. */
  regressions: TrajectoryRegression[];
  /** `1 - mean(cosine(emb[i], emb[i-1]))`, clamped [0,1]; null on < 3 embedded points. */
  drift_score: number | null;
}

/** Normalize a caller metric filter the same way the writer stores it; empty → undefined. */
function normalizeMetricFilter(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // Measured linear through findTrajectory: 0.30 ms on a 512 K underscore
    // metric, 2.9 ms on a 512 K `_a` run, ratio 2.0 on a doubling. The attack
    // this rule describes — a long `_` run plus a rejecting suffix — cannot
    // reach here: the replace on the line above collapses every non-[a-z0-9]
    // run to a SINGLE `_`, so the longest run this ever walks is one character.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^_+|_+$/g, "");
  return v.length > 0 ? v : undefined;
}

/**
 * Parse a pgvector text embedding (`[0.1,0.2,…]`) into a `number[]`. Returns
 * null for a null cell or any parse failure — drift degrades gracefully.
 */
function parseEmbedding(raw: string | null): number[] | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out = arr.map((x) => Number(x));
    return out.every((x) => Number.isFinite(x)) ? out : null;
  } catch {
    return null;
  }
}

/** Read the regression threshold from env with a safe fallback to the default. */
export function resolveRegressionThreshold(
  env: string | undefined = process.env.MEMRAIN_TRAJECTORY_REGRESSION_THRESHOLD,
): number {
  if (!env) return DEFAULT_REGRESSION_THRESHOLD;
  const n = Number.parseFloat(env);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_REGRESSION_THRESHOLD;
  return n;
}

/** Cosine similarity of two equal-length vectors; 0 on any degenerate input. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Detect chronological regressions across metric points. Groups by `metric` so
 * interleaved metrics never trip a false cross-metric drop, then walks each
 * metric's consecutive value pairs (points arrive sorted by anchor date ASC
 * from findTrajectory) and fires when `(newer - older) / older <= -threshold`.
 * A metric starting at exactly 0 can't yield a relative delta and is skipped.
 */
export function detectRegressions(
  points: readonly TrajectoryPoint[],
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): TrajectoryRegression[] {
  const out: TrajectoryRegression[] = [];
  const byMetric = new Map<string, TrajectoryPoint[]>();
  for (const p of points) {
    if (p.metric === null || p.value === null || !Number.isFinite(p.value)) continue;
    if (!byMetric.has(p.metric)) byMetric.set(p.metric, []);
    byMetric.get(p.metric)!.push(p);
  }
  for (const [metric, series] of byMetric) {
    for (let i = 1; i < series.length; i++) {
      const older = series[i - 1]!;
      const newer = series[i]!;
      const oldVal = older.value!;
      const newVal = newer.value!;
      if (oldVal === 0) continue;
      const delta = (newVal - oldVal) / oldVal;
      if (delta <= -threshold) {
        out.push({
          metric,
          from_value: oldVal,
          from_date: older.at.slice(0, 10),
          to_value: newVal,
          to_date: newer.at.slice(0, 10),
          delta_pct: delta,
        });
      }
    }
  }
  return out;
}

/**
 * Drift score over the trajectory's embeddings: `1 - mean(cosine(emb[i],
 * emb[i-1]))`, clamped to [0,1]. Null when fewer than 3 points carry an
 * embedding (the statistic is meaningless on a tiny sample). Requires
 * `findTrajectory(..., { includeEmbedding: true })` to have populated them.
 */
export function computeDriftScore(points: readonly TrajectoryPoint[]): number | null {
  const withEmb = points.filter(
    (p) => p.embedding !== null && p.embedding.length > 0,
  );
  if (withEmb.length < 3) return null;
  let sumCos = 0;
  let pairs = 0;
  for (let i = 1; i < withEmb.length; i++) {
    sumCos += cosineSim(withEmb[i - 1]!.embedding!, withEmb[i]!.embedding!);
    pairs += 1;
  }
  if (pairs === 0) return null;
  const drift = 1 - sumCos / pairs;
  return drift < 0 ? 0 : drift > 1 ? 1 : drift;
}

/** Compose regressions + drift_score into one stats object. */
export function computeTrajectoryStats(
  points: readonly TrajectoryPoint[],
  opts: { threshold?: number } = {},
): TrajectoryStats {
  const threshold = opts.threshold ?? resolveRegressionThreshold();
  return {
    regressions: detectRegressions(points, threshold),
    drift_score: computeDriftScore(points),
  };
}

/**
 * Convenience read: fetch an entity's metric-claim trajectory (embeddings on)
 * and compute its derived stats in one call. Defaults `claimKind` to `metric`
 * so only typed numeric claims participate — the metric-trajectory surface.
 * LLM-free; deterministic. Not an MCP op (the raw `findTrajectory` stays the
 * wired reader); this is the plumbing the eval + scorecard paths consume.
 */
export async function findTrajectoryStats(
  storage: Storage,
  entitySlug: string,
  opts: FindTrajectoryOptions & { threshold?: number } = {},
): Promise<{ points: TrajectoryPoint[]; stats: TrajectoryStats }> {
  const points = await findTrajectory(storage, entitySlug, {
    ...opts,
    claimKind: opts.claimKind ?? "metric",
    includeEmbedding: true,
  });
  const stats = computeTrajectoryStats(points, {
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  });
  return { points, stats };
}
