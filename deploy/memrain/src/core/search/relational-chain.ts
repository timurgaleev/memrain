/**
 * Multi-hop relational chains: walk 1-3 typed hops ("alice -> companies she
 * invested in -> their founders") over `links`, one bounded query per hop, with
 * path state, scoring and tie breaking in TypeScript.
 *
 * Determinism: frontier selection, path retention and answer order use
 * (score DESC, slug ASC) with a UTF-8 byte comparison, and the per-node
 * neighbour cap orders `COLLATE "C"`, so Postgres and PGLite produce the same
 * output for the same rows.
 *
 * Path state: each retained path keeps its own node list; cycle prevention is
 * path-local and applies only to nodes that expand again, so the last hop may
 * land on a node the path already passed ("which companies do the founders of
 * the companies alice invested in work at?" can answer one of those companies,
 * "who invested in the companies alice founded?" can answer alice) unless the
 * plan excludes the anchor.
 *
 * Bounds: at most FRONTIER_CAP nodes expand per hop, each with at most
 * NEIGHBOR_CAP edges, and at most PATHS_PER_NODE paths are kept per node, so
 * the work per hop is bounded whatever a hub's degree.
 *
 * Orientation: an edge is read by the relation's page-type signature, not only
 * by its stored direction. Edges an explicit writer stored (frontmatter, a
 * manual `link` call) keep their direction and count only when it fits the
 * signature. Body-derived edges ("founded by [[alice]]" on a company page is
 * stored company -> person) are read forward when the stored direction fits,
 * flipped when only the reverse fits, and walked at UNCERTAIN_EDGE_WEIGHT when
 * both fit; an edge that fits neither is no hop. A page with no chain type
 * (untyped, or typed outside the signatures) fits either side, since many
 * brains type loosely: such an edge keeps its stored direction at full weight.
 *
 * Scoring: a path's weight is the product of the hub weight of every node it
 * passes through (half at CHAIN_HUB_HALF_DEGREE caller-visible chain neighbours)
 * and of UNCERTAIN_EDGE_WEIGHT for each uncertain edge; a node scores the sum
 * of its paths' weights. A hub with many founders or investors then no longer
 * outranks a specific answer, nor pushes it out of the frontier.
 *
 * Visibility: every hop reads only links stored in the caller's sources, with
 * both ends live (`liveEdgeSql`), and lands only on nodes `chainNodeFenceSql`
 * admits: a node with a page row must be readable by the caller (source, soft
 * delete, held or quarantined page and truth mirrors, trust floor, and for a
 * remote caller diary/journal pages and owner-only lineage). A remote walk also
 * drops diary endpoints on the link itself.
 *
 * Tested in tests/relational_chain.test.ts.
 */
import type { Storage } from "../storage.ts";
import { liveEdgeSql } from "../links.ts";
import { linkDiarySql } from "../links-privacy.ts";
import { linkValiditySql } from "../link-validity.ts";
import { andSourceScope } from "../source-scope.ts";
import { eligiblePageSql } from "../bounded-read.ts";
import { assertSqlAlias } from "../quarantine.ts";
import { pageRankSql, trustRank, type TrustTier } from "../trust-tier.ts";
import { CHAIN_LINK_TYPES, LINK_SIGNATURES, signatureOf, type ChainHop, type RelationalPlan } from "./relational-plan.ts";

export const FRONTIER_CAP = 50;
export const NEIGHBOR_CAP = 100;
export const PATHS_PER_NODE = 10;
/** Link rows read per frontier node before (from, to) duplicates collapse. */
const RAW_PER_NODE = NEIGHBOR_CAP * 2 + 1;
/** Degree at which a path's weight through an intermediate node halves. */
export const CHAIN_HUB_HALF_DEGREE = 32;
/** Weight of an edge whose direction the page types cannot settle. */
export const UNCERTAIN_EDGE_WEIGHT = 0.5;
/** Neighbours counted per node for its hub weight; past this the weight barely moves. */
const DEGREE_SATURATION = 1000;

/** `1 / (1 + ((max(n, 1) - 1) / h)^2)`: 1 for a leaf, 0.5 at degree h + 1. */
export function hubWeight(degree: number, h: number = CHAIN_HUB_HALF_DEGREE): number {
  if (!(h > 0) || !Number.isFinite(degree)) return 1;
  const x = (Math.max(degree, 1) - 1) / h;
  return 1 / (1 + x * x);
}

export interface ChainScope {
  /** Tenant scope. `undefined` => unscoped; `[]` => nothing. */
  sourceIds?: string[];
  /** Non-operator caller: diary/journal pages and owner-only lineage are fenced. */
  remote?: boolean;
  /** Trust floor applied to every node with a page row. */
  minTrust?: TrustTier;
}

export interface ChainAnswer {
  slug: string;
  /** Summed weight of the retained paths that end here. */
  score: number;
  /** Best path, anchor first, answer last. */
  path: string[];
  /** Link type of the last hop on the best path. */
  relation: string;
}

export type ChainStatus = "fired" | "anchor_fenced" | "no_edges" | "empty_hop" | "truncated";

export interface ChainResult {
  answers: ChainAnswer[];
  status: ChainStatus;
  /** Frontier size and edge count per hop, for telemetry. */
  perHop: Array<{ linkType: string; toward: ChainHop["toward"]; frontier: number; edges: number }>;
}

interface PathRec {
  slugs: string[];
  relation: string;
  key: string;
  weight: number;
}

const encoder = new TextEncoder();

/** UTF-8 byte order, the same order `COLLATE "C"` gives on both engines. */
export function byteCompare(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * SQL that is true unless `slugExpr` names a page the caller may not read. A
 * slug with no page row (a dangling link target) is admitted, as in every
 * other graph read; it has no body to leak and no outbound links of its own.
 */
export function chainNodeFenceSql(slugExpr: string, scope: ChainScope, params: unknown[]): string {
  for (const part of slugExpr.split(".")) assertSqlAlias(part);
  const sourceFilter = andSourceScope("np.source_id", scope.sourceIds, params);
  const trust = scope.minTrust && scope.minTrust !== "external"
    ? ` AND (${pageRankSql("np")}) >= $${params.push(trustRank(scope.minTrust))}::int` : "";
  return `NOT EXISTS (SELECT 1 FROM pages np WHERE np.slug = ${slugExpr}
      AND NOT (${eligiblePageSql("np", scope.remote === true)}${sourceFilter}${trust}))`;
}

function aggregate(paths: PathRec[]): Array<{ slug: string; score: number; paths: PathRec[] }> {
  const byNode = new Map<string, { slug: string; score: number; paths: PathRec[] }>();
  for (const p of paths) {
    const slug = p.slugs[p.slugs.length - 1]!;
    let agg = byNode.get(slug);
    if (!agg) {
      agg = { slug, score: 0, paths: [] };
      byNode.set(slug, agg);
    }
    agg.paths.push(p);
  }
  for (const agg of byNode.values()) {
    // Summed in key order, so the float total is the same whatever order the rows came in.
    agg.paths.sort((a, b) => byteCompare(a.key, b.key));
    agg.score = agg.paths.reduce((sum, p) => sum + p.weight, 0);
    agg.paths.sort((a, b) => b.weight - a.weight || byteCompare(a.key, b.key));
  }
  return [...byNode.values()].sort((a, b) => b.score - a.score || byteCompare(a.slug, b.slug));
}

type Orientation = "canonical" | "stored" | "flipped" | "uncertain";

interface HopEdge { from_slug: string; to_slug: string; orientation: Orientation; capped: boolean }

const SIGNATURE_TYPES: ReadonlySet<string> = new Set(
  Object.values(LINK_SIGNATURES).flatMap(s => [...s.subject, ...s.object]),
);

/**
 * The orientation of a link row by its endpoints' page types (module header),
 * as SQL over `fp`/`tp` (the pages at the stored source and target) and the
 * signature arrays bound at `subj`/`obj`/`sig`. NULL: the edge is no hop.
 */
function orientationSql(alias: string, subj: string, obj: string, sig: string): string {
  const known = (t: string) => `COALESCE(${t}.type = ANY(${sig}::text[]), false)`;
  const fits = (t: string, side: string) => `(NOT ${known(t)} OR ${t}.type = ANY(${side}::text[]))`;
  const fwd = `(${fits("fp", subj)} AND ${fits("tp", obj)})`;
  const rev = `(${fits("tp", subj)} AND ${fits("fp", obj)})`;
  return `CASE
      WHEN ${alias}.link_source IN ('frontmatter', 'manual') THEN CASE WHEN ${fwd} THEN 'canonical' END
      WHEN ${fwd} AND ${rev} THEN CASE WHEN ${known("fp")} AND ${known("tp")} THEN 'uncertain' ELSE 'stored' END
      WHEN ${fwd} THEN 'stored'
      WHEN ${rev} THEN 'flipped'
    END`;
}

async function hopEdges(storage: Storage, frontier: string[], hop: ChainHop, scope: ChainScope): Promise<HopEdge[]> {
  const sig = signatureOf(hop.linkType) ?? { subject: [], object: [] };
  const params: unknown[] = [frontier, hop.linkType, [...sig.subject], [...sig.object], [...SIGNATURE_TYPES]];
  // One branch per stored direction the frontier node can sit on; each reads
  // the edge's semantic subject and object after orientation.
  const branch = (frontierCol: "source_slug" | "target_slug"): string => {
    const a = frontierCol === "source_slug" ? "lo" : "li";
    const sourceScope = andSourceScope(`${a}.source_id`, scope.sourceIds, params);
    const validity = linkValiditySql(a, { status: hop.status ?? "active" }, params);
    const diary = linkDiarySql(a, scope.remote, params);
    return `SELECT ${a}.id, ${a}.written_at, ${a}.source_slug, ${a}.target_slug,
             ${orientationSql(a, "$3", "$4", "$5")} AS orientation
        FROM links ${a}
        LEFT JOIN pages fp ON fp.slug = ${a}.source_slug
        LEFT JOIN pages tp ON tp.slug = ${a}.target_slug
       WHERE ${a}.${frontierCol} = f.from_slug AND ${a}.type = $2 AND ${a}.source_slug <> ${a}.target_slug${sourceScope}${validity}${diary}
         AND ${liveEdgeSql(a)}`;
  };
  const outBranch = branch("source_slug");
  const inBranch = branch("target_slug");
  // Walking toward the object leaves from the subject, and the reverse.
  const [fromSide, toSide] = hop.toward === "object" ? ["subj", "obj"] : ["obj", "subj"];
  const fence = chainNodeFenceSql(`o.${toSide}`, scope, params);
  // A head noun ("which companies") drops landing pages typed as another chain
  // type before the per-node cap, so wrong-typed neighbours never use it up;
  // untyped or otherwise typed pages stay, since many brains type loosely.
  const otherTypes = hop.nodeType ? [...SIGNATURE_TYPES].filter(t => t !== hop.nodeType) : [];
  const typeFilter = otherTypes.length > 0
    ? ` AND NOT EXISTS (SELECT 1 FROM pages xp WHERE xp.slug = o.${toSide} AND xp.type = ANY($${params.push(otherTypes)}::text[])${andSourceScope("xp.source_id", scope.sourceIds, params)})`
    : "";
  // Each frontier node reads at most RAW_PER_NODE link rows, newest first, so a
  // hub costs the same as any other node. Twice the cap leaves room for the
  // odd duplicate (from, to) row; duplicates collapse below, the best
  // orientation kept.
  params.push(RAW_PER_NODE);
  const rawParam = `$${params.length}`;
  const r = await storage.engine().query<{ from_slug: string; to_slug: string; orientation: Orientation }>(
    `SELECT f.from_slug, e.to_slug, e.orientation
       FROM unnest($1::text[]) AS f(from_slug)
       CROSS JOIN LATERAL (
         SELECT o.${toSide} AS to_slug, o.orientation, o.written_at, o.id
           FROM (
             SELECT c.id, c.written_at, c.orientation,
                    CASE WHEN c.orientation = 'flipped' THEN c.target_slug ELSE c.source_slug END AS subj,
                    CASE WHEN c.orientation = 'flipped' THEN c.source_slug ELSE c.target_slug END AS obj
               FROM (${outBranch} UNION ALL ${inBranch}) c
              WHERE c.orientation IS NOT NULL
           ) o
          WHERE o.${fromSide} = f.from_slug AND o.${toSide} <> f.from_slug${typeFilter}
            AND ${fence}
          ORDER BY o.written_at DESC, o.${toSide} COLLATE "C" ASC, o.id DESC
          LIMIT ${rawParam}
       ) e
      ORDER BY f.from_slug COLLATE "C" ASC, e.written_at DESC, e.to_slug COLLATE "C" ASC, e.id DESC`,
    params,
  );
  const rank: Record<Orientation, number> = { canonical: 0, stored: 1, flipped: 2, uncertain: 3 };
  const seen = new Map<string, { tos: Map<string, { from_slug: string; to_slug: string; orientation: Orientation }>; rows: number }>();
  for (const row of r.rows) {
    const s = seen.get(row.from_slug) ?? { tos: new Map<string, { from_slug: string; to_slug: string; orientation: Orientation }>(), rows: 0 };
    seen.set(row.from_slug, s);
    s.rows += 1;
    const prev = s.tos.get(row.to_slug);
    if (prev) {
      // Two rows for one logical edge: the better-established direction stands.
      if (rank[row.orientation] < rank[prev.orientation]) s.tos.set(row.to_slug, { ...prev, orientation: row.orientation });
      continue;
    }
    s.tos.set(row.to_slug, row);
  }
  const out: HopEdge[] = [];
  for (const [from, s] of seen) {
    const capped = s.tos.size > NEIGHBOR_CAP || s.rows >= RAW_PER_NODE;
    for (const row of [...s.tos.values()].slice(0, NEIGHBOR_CAP)) out.push({ from_slug: from, to_slug: row.to_slug, orientation: row.orientation, capped });
  }
  return out;
}

/**
 * Caller-visible chain neighbours of each node (distinct pages over every
 * chain relation, live and readable), counted up to DEGREE_SATURATION, for
 * the hub weight of a node a path passes through.
 */
async function chainDegrees(storage: Storage, nodes: string[], scope: ChainScope): Promise<Map<string, number>> {
  if (nodes.length === 0) return new Map();
  const params: unknown[] = [nodes, CHAIN_LINK_TYPES, DEGREE_SATURATION];
  const sourceScope = andSourceScope("l.source_id", scope.sourceIds, params);
  const diary = linkDiarySql("l", scope.remote, params);
  const fence = chainNodeFenceSql("nb.slug", scope, params);
  const r = await storage.engine().query<{ slug: string; n: number | string }>(
    `SELECT f.slug, (SELECT count(*)::int FROM (
         SELECT DISTINCT nb.slug FROM (
           SELECT CASE WHEN l.source_slug = f.slug THEN l.target_slug ELSE l.source_slug END AS slug
             FROM links l
            WHERE (l.source_slug = f.slug OR l.target_slug = f.slug) AND l.source_slug <> l.target_slug
              AND l.type = ANY($2::text[])${sourceScope}${diary} AND ${liveEdgeSql("l")}
         ) nb
         WHERE ${fence}
         LIMIT $3::int) x) AS n
       FROM unnest($1::text[]) AS f(slug)`,
    params,
  );
  return new Map(r.rows.map(row => [row.slug, Number(row.n)]));
}

/** True when the anchor page itself passes the node fence (a fenced anchor walks nowhere). */
async function anchorAdmitted(storage: Storage, slug: string, scope: ChainScope): Promise<boolean> {
  const params: unknown[] = [slug];
  const fence = chainNodeFenceSql("a.slug", scope, params);
  const r = await storage.engine().query<{ ok: boolean }>(
    `SELECT ${fence} AS ok FROM (SELECT $1::text AS slug) a`, params,
  );
  return r.rows[0]?.ok === true;
}

/**
 * Run a chain plan from a resolved anchor slug. Never throws for an empty
 * graph: an empty first hop is `no_edges`, a later one `empty_hop`.
 */
export async function runRelationalChain(
  storage: Storage,
  anchorSlug: string,
  plan: Pick<RelationalPlan, "hops" | "excludeAnchor">,
  scope: ChainScope = {},
): Promise<ChainResult> {
  const perHop: ChainResult["perHop"] = [];
  if (!(await anchorAdmitted(storage, anchorSlug, scope))) return { answers: [], status: "anchor_fenced", perHop };
  let truncated = false;
  let paths: PathRec[] = [{ slugs: [anchorSlug], relation: "", key: anchorSlug, weight: 1 }];

  for (let i = 0; i < plan.hops.length; i++) {
    const hop = plan.hops[i]!;
    let nodes = aggregate(paths);
    if (nodes.length > FRONTIER_CAP) {
      truncated = true;
      nodes = nodes.slice(0, FRONTIER_CAP);
    }
    paths = [];
    for (const n of nodes) {
      if (n.paths.length > PATHS_PER_NODE) truncated = true;
      paths.push(...n.paths.slice(0, PATHS_PER_NODE));
    }
    const frontier = nodes.map(n => n.slug);
    const [edges, degrees] = await Promise.all([
      hopEdges(storage, frontier, hop, scope),
      // The anchor is not an intermediate: only later frontiers are dampened.
      i > 0 ? chainDegrees(storage, frontier, scope) : Promise.resolve(new Map<string, number>()),
    ]);
    const byFrom = new Map<string, HopEdge[]>();
    for (const e of edges) {
      if (e.capped) truncated = true;
      const list = byFrom.get(e.from_slug) ?? [];
      list.push(e);
      byFrom.set(e.from_slug, list);
    }
    const last = i === plan.hops.length - 1;
    const next: PathRec[] = [];
    for (const p of paths) {
      const tail = p.slugs[p.slugs.length - 1]!;
      const hub = i > 0 ? hubWeight(degrees.get(tail) ?? 1) : 1;
      for (const e of byFrom.get(tail) ?? []) {
        if (!last && p.slugs.includes(e.to_slug)) continue;
        const weight = p.weight * hub * (e.orientation === "uncertain" ? UNCERTAIN_EDGE_WEIGHT : 1);
        next.push({ slugs: [...p.slugs, e.to_slug], relation: hop.linkType, key: `${p.key}\u0001${e.to_slug}`, weight });
      }
    }
    perHop.push({ linkType: hop.linkType, toward: hop.toward, frontier: nodes.length, edges: next.length });
    if (next.length === 0) return { answers: [], status: i === 0 ? "no_edges" : "empty_hop", perHop };
    paths = next;
  }

  const answers = aggregate(paths)
    .filter(n => !(plan.excludeAnchor && n.slug === anchorSlug))
    .map(n => ({ slug: n.slug, score: n.score, path: n.paths[0]!.slugs, relation: n.paths[0]!.relation }));
  if (answers.length === 0) return { answers: [], status: "empty_hop", perHop };
  return { answers, status: truncated ? "truncated" : "fired", perHop };
}
