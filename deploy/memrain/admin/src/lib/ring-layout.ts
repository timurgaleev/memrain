// Layout of the one-hop radial graph: the centre, its neighbours on a ring
// grouped by link type into contiguous arcs, and one drawn edge per pair and
// type. Plain trigonometry, no DOM, so the drawing is deterministic and the
// root test runner can load it.

import type { NeighborEdge } from "./tool-result.ts";
import { lastSegment } from "./format.ts";

export interface RingNode {
  key: string;
  slug: string | null; // null for a "+N more" bucket
  label: string;
  type: string;
  x: number;
  y: number;
  angle: number;
}

export interface RingEdge {
  key: string;
  type: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Both pages link to each other with this type. */
  both: boolean;
  /**
   * Perpendicular shift in px, measured against the centre→neighbour
   * direction whichever way the edge points, so several types on one pair
   * stay side by side.
   */
  offset: number;
}

export const RING_C = 300;
export const MAX_NODES = 30;
export const MAX_PER_TYPE = 8;
export const OUTER_R = 280;
export const NODE_R = 7;
/** Edges the graph view draws; it asks for one more to know if there are others. */
export const GRAPH_VIEW_LIMIT = 60;
const OFFSET_STEP = 12;

function otherEnd(e: NeighborEdge, center: string): string {
  return e.source_slug === center ? e.target_slug : e.source_slug;
}

function slotAngle(i: number, n: number): number {
  // One or two neighbours sit level with the centre; a ring starts at the top.
  if (n === 1) return 0;
  if (n === 2) return i * Math.PI;
  return -Math.PI / 2 + (2 * Math.PI * i) / n;
}

export function ringLayout(center: string, edges: NeighborEdge[], radius: number): { nodes: RingNode[]; edges: RingEdge[]; types: string[] } {
  const typeOf = new Map<string, string>();
  for (const e of edges) {
    const o = otherEnd(e, center);
    if (o === center || o === "") continue;
    const prev = typeOf.get(o);
    if (prev === undefined || e.type < prev) typeOf.set(o, e.type);
  }
  const byType = new Map<string, string[]>();
  for (const [slug, t] of typeOf) byType.set(t, [...(byType.get(t) ?? []), slug]);
  const nodeTypes = [...byType.keys()].sort();

  const slots: Omit<RingNode, "x" | "y" | "angle">[] = [];
  for (const t of nodeTypes) {
    const members = (byType.get(t) ?? []).sort();
    const room = MAX_NODES - slots.length;
    if (room <= 0) {
      slots.push({ key: `more:${t}`, slug: null, label: `+${members.length} more`, type: t });
      continue;
    }
    const cap = Math.min(MAX_PER_TYPE, room);
    const shown = members.length > cap ? members.slice(0, Math.max(0, cap - 1)) : members;
    for (const s of shown) slots.push({ key: `n:${s}`, slug: s, label: lastSegment(s, 18), type: t });
    if (shown.length < members.length) {
      slots.push({ key: `more:${t}`, slug: null, label: `+${members.length - shown.length} more`, type: t });
    }
  }
  const nodes: RingNode[] = slots.map((s, i) => {
    const angle = slotAngle(i, slots.length);
    return { ...s, angle, x: RING_C + radius * Math.cos(angle), y: RING_C + radius * Math.sin(angle) };
  });

  // One edge per neighbour and type: the same type in both directions merges
  // into a two-headed edge; different types on one pair stay separate.
  const pos = new Map(nodes.filter((n) => n.slug).map((n) => [n.slug as string, n]));
  const pairs = new Map<string, Map<string, { out: boolean; in: boolean }>>();
  for (const e of edges) {
    const o = otherEnd(e, center);
    if (!pos.has(o)) continue;
    const perType = pairs.get(o) ?? new Map<string, { out: boolean; in: boolean }>();
    const dir = perType.get(e.type) ?? { out: false, in: false };
    if (e.source_slug === center) dir.out = true;
    else dir.in = true;
    perType.set(e.type, dir);
    pairs.set(o, perType);
  }
  const centerPt = { x: RING_C, y: RING_C };
  const drawn: RingEdge[] = [];
  const types = new Set<string>(nodeTypes);
  for (const [slug, perType] of pairs) {
    const n = pos.get(slug) as RingNode;
    const list = [...perType.entries()].sort(([a], [b]) => a.localeCompare(b));
    list.forEach(([type, dir], i) => {
      types.add(type);
      const both = dir.out && dir.in;
      const outbound = dir.out;
      drawn.push({
        key: `${slug}:${type}`,
        type,
        from: outbound ? centerPt : n,
        to: outbound ? n : centerPt,
        both,
        offset: (i - (list.length - 1) / 2) * OFFSET_STEP,
      });
    });
  }
  return { nodes, edges: drawn, types: [...types].sort() };
}

export function graphTruncated(edges: readonly unknown[], limit: number): boolean {
  return edges.length > limit;
}

const LABEL_MAX_SCALE = 1.25;
const LABEL_MIN_PX = 9;

/**
 * Label size for a viewBox `viewW` wide drawn `clientW` px wide: grow the
 * labels as the drawing shrinks, up to a cap that keeps them inside the view,
 * and hide them once even the capped size is unreadable.
 */
export function labelScale(viewW: number, clientW: number, basePx: number): { scale: number; hide: boolean } {
  if (!(clientW > 0) || !(viewW > 0)) return { scale: 1, hide: false };
  const scale = Math.min(LABEL_MAX_SCALE, Math.max(1, viewW / clientW));
  return { scale, hide: (basePx * scale * clientW) / viewW < LABEL_MIN_PX };
}
