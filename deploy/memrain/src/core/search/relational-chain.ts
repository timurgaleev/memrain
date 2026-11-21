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
import { LINK_SIGNATURES, type ChainHop, type RelationalPlan } from "./relational-plan.ts";

export const FRONTIER_CAP = 50;
export const NEIGHBOR_CAP = 100;
export const PATHS_PER_NODE = 10;
/** Link rows read per frontier node before (from, to) duplicates collapse. */
const RAW_PER_NODE = NEIGHBOR_CAP * 2 + 1;

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
  /** Number of retained paths that end here. */
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
    agg.score += 1;
    agg.paths.push(p);
  }
  for (const agg of byNode.values()) agg.paths.sort((a, b) => byteCompare(a.key, b.key));
  return [...byNode.values()].sort((a, b) => b.score - a.score || byteCompare(a.slug, b.slug));
}

interface HopEdge { from_slug: string; to_slug: string; capped: boolean }

const SIGNATURE_TYPES: ReadonlySet<string> = new Set(
  Object.values(LINK_SIGNATURES).flatMap(s => [...s.subject, ...s.object]),
);

async function hopEdges(storage: Storage, frontier: string[], hop: ChainHop, scope: ChainScope): Promise<HopEdge[]> {
  const fromCol = hop.toward === "object" ? "l.source_slug" : "l.target_slug";
  const toCol = hop.toward === "object" ? "l.target_slug" : "l.source_slug";
  const params: unknown[] = [frontier, hop.linkType];
  const sourceScope = andSourceScope("l.source_id", scope.sourceIds, params);
  const validity = linkValiditySql("l", { status: hop.status ?? "all" }, params);
  const diary = linkDiarySql("l", scope.remote, params);
  const fence = chainNodeFenceSql(toCol, scope, params);
  // A head noun ("which companies") drops landing pages typed as another chain
  // type before the per-node cap, so wrong-typed neighbours never use it up;
  // untyped or otherwise typed pages stay, since many brains type loosely.
  const otherTypes = hop.nodeType ? [...SIGNATURE_TYPES].filter(t => t !== hop.nodeType) : [];
  const typeFilter = otherTypes.length > 0
    ? ` AND NOT EXISTS (SELECT 1 FROM pages xp WHERE xp.slug = ${toCol} AND xp.type = ANY($${params.push(otherTypes)}::text[])${andSourceScope("xp.source_id", scope.sourceIds, params)})`
    : "";
  // Each frontier node reads at most RAW_PER_NODE link rows, newest first, so a
  // hub costs the same as any other node. Twice the cap leaves room for the
  // odd duplicate (from, to) row; duplicates collapse below, newest kept.
  params.push(RAW_PER_NODE);
  const rawParam = `$${params.length}`;
  const r = await storage.engine().query<{ from_slug: string; to_slug: string }>(
    `SELECT f.from_slug, e.to_slug
       FROM unnest($1::text[]) AS f(from_slug)
       CROSS JOIN LATERAL (
         SELECT ${toCol} AS to_slug, l.written_at, l.id
           FROM links l
          WHERE ${fromCol} = f.from_slug AND l.type = $2 AND ${toCol} <> f.from_slug${sourceScope}${validity}${diary}${typeFilter}
            AND ${liveEdgeSql("l")}
            AND ${fence}
          ORDER BY l.written_at DESC, ${toCol} COLLATE "C" ASC, l.id DESC
          LIMIT ${rawParam}
       ) e
      ORDER BY f.from_slug COLLATE "C" ASC, e.written_at DESC, e.to_slug COLLATE "C" ASC, e.id DESC`,
    params,
  );
  const seen = new Map<string, { tos: Set<string>; rows: number }>();
  const out: Array<{ from_slug: string; to_slug: string }> = [];
  for (const row of r.rows) {
    const s = seen.get(row.from_slug) ?? { tos: new Set<string>(), rows: 0 };
    seen.set(row.from_slug, s);
    s.rows += 1;
    if (s.tos.has(row.to_slug)) continue;
    s.tos.add(row.to_slug);
    if (s.tos.size <= NEIGHBOR_CAP) out.push(row);
  }
  const capped = (from: string) => {
    const s = seen.get(from)!;
    return s.tos.size > NEIGHBOR_CAP || s.rows >= RAW_PER_NODE;
  };
  return out.map(row => ({ from_slug: row.from_slug, to_slug: row.to_slug, capped: capped(row.from_slug) }));
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
  let paths: PathRec[] = [{ slugs: [anchorSlug], relation: "", key: anchorSlug }];

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
    const edges = await hopEdges(storage, nodes.map(n => n.slug), hop, scope);
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
      for (const e of byFrom.get(tail) ?? []) {
        if (!last && p.slugs.includes(e.to_slug)) continue;
        next.push({ slugs: [...p.slugs, e.to_slug], relation: hop.linkType, key: `${p.key}\u0001${e.to_slug}` });
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
