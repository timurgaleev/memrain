import { useMemo, useState } from "react";
import type { NeighborEdge } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { lastSegment } from "../lib/format.ts";

// One-hop neighborhood as a radial SVG: the centre node, its neighbors on a
// ring grouped by link type into contiguous arcs, and (full page only) one
// expanded node's own neighbors on an outer ring. No layout library: the
// positions are plain trigonometry, so the drawing is deterministic.

const C = 300;
const MAX_NODES = 30;
const MAX_PER_TYPE = 8;
const OUTER_R = 280;
const NODE_R = 7;

interface Node {
  key: string;
  slug: string | null; // null for a "+N more" bucket
  label: string;
  type: string;
  x: number;
  y: number;
  angle: number;
}

interface Edge {
  key: string;
  type: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

function otherEnd(e: NeighborEdge, center: string): string {
  return e.source_slug === center ? e.target_slug : e.source_slug;
}

function colorIndex(types: string[], t: string): number {
  return (Math.max(0, types.indexOf(t)) % 8) + 1;
}

/** Pull both endpoints in by the node radius so arrowheads stay visible. */
function shorten(a: { x: number; y: number }, b: { x: number; y: number }, by: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x1: a.x + ux * by, y1: a.y + uy * by, x2: b.x - ux * (by + 2), y2: b.y - uy * (by + 2) };
}

function ringLayout(center: string, edges: NeighborEdge[], radius: number) {
  const typeOf = new Map<string, string>();
  for (const e of edges) {
    const o = otherEnd(e, center);
    if (o === center || o === "") continue;
    const prev = typeOf.get(o);
    if (prev === undefined || e.type < prev) typeOf.set(o, e.type);
  }
  const byType = new Map<string, string[]>();
  for (const [slug, t] of typeOf) byType.set(t, [...(byType.get(t) ?? []), slug]);
  const types = [...byType.keys()].sort();

  const slots: Omit<Node, "x" | "y" | "angle">[] = [];
  for (const t of types) {
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
  const nodes: Node[] = slots.map((s, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, slots.length);
    return { ...s, angle, x: C + radius * Math.cos(angle), y: C + radius * Math.sin(angle) };
  });
  const pos = new Map(nodes.filter((n) => n.slug).map((n) => [n.slug as string, n]));
  const centerPt = { x: C, y: C };
  const drawn: Edge[] = [];
  for (const e of edges) {
    const n = pos.get(otherEnd(e, center));
    if (!n) continue;
    const outbound = e.source_slug === center;
    drawn.push({ key: `${e.id}:${e.type}:${e.source_slug}>${e.target_slug}`, type: e.type, from: outbound ? centerPt : n, to: outbound ? n : centerPt });
  }
  return { nodes, edges: drawn, types };
}

interface Props {
  center: string;
  edges: NeighborEdge[];
  mini?: boolean;
  /** Full page only: fetch one node's neighbors for the outer ring. */
  onExpand?: (slug: string) => Promise<NeighborEdge[]>;
}

export function RadialGraph({ center, edges, mini = false, onExpand }: Props) {
  const radius = mini ? 120 : 220;
  const layout = useMemo(() => ringLayout(center, edges, radius), [center, edges, radius]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ slug: string; edges: NeighborEdge[] } | null>(null);
  const [expandState, setExpandState] = useState<"idle" | "loading" | "error">("idle");

  const outer = useMemo(() => {
    if (!expanded) return { nodes: [] as Node[], edges: [] as Edge[] };
    const anchor = layout.nodes.find((n) => n.slug === expanded.slug);
    if (!anchor) return { nodes: [], edges: [] };
    const taken = new Set([center, ...layout.nodes.map((n) => n.slug ?? "")]);
    const others = [...new Map(expanded.edges.map((e) => [otherEnd(e, expanded.slug), e])).entries()]
      .filter(([s]) => !taken.has(s) && s !== "")
      .slice(0, 20);
    const spread = Math.min(Math.PI / 2, 0.16 * others.length);
    const nodes: Node[] = others.map(([s, e], i) => {
      const angle = anchor.angle - spread / 2 + (others.length > 1 ? (spread * i) / (others.length - 1) : 0);
      return { key: `o:${s}`, slug: s, label: lastSegment(s, 14), type: e.type, angle, x: C + OUTER_R * Math.cos(angle), y: C + OUTER_R * Math.sin(angle) };
    });
    const oedges: Edge[] = nodes.map((n, i) => {
      const e = (others[i] as [string, NeighborEdge])[1];
      const out = e.source_slug === expanded.slug;
      return { key: `oe:${n.key}`, type: e.type, from: out ? anchor : n, to: out ? n : anchor };
    });
    return { nodes, edges: oedges };
  }, [expanded, layout, center]);

  const allTypes = useMemo(
    () => [...new Set([...layout.types, ...outer.edges.map((e) => e.type)])].sort(),
    [layout.types, outer.edges],
  );

  const expand = async (slug: string) => {
    if (!onExpand) return;
    setExpandState("loading");
    try {
      setExpanded({ slug, edges: await onExpand(slug) });
      setExpandState("idle");
    } catch {
      setExpandState("error");
    }
  };

  const go = (slug: string) => { window.location.hash = buildHash({ name: "graph", param: slug }); };

  const renderNode = (n: Node, ring: "inner" | "outer") => {
    const right = Math.cos(n.angle) >= -0.01;
    const lx = n.x + Math.cos(n.angle) * 12;
    const ly = n.y + Math.sin(n.angle) * 12;
    const ci = colorIndex(allTypes, n.type);
    const dim = selected !== null && selected !== n.slug && ring === "inner";
    if (n.slug === null) {
      return (
        <g key={n.key} className="g-node g-more">
          <circle cx={n.x} cy={n.y} r={NODE_R - 2} className={`gk${ci}`} />
          <text x={lx} y={ly} dy="0.35em" textAnchor={right ? "start" : "end"}>{n.label}</text>
        </g>
      );
    }
    const slug = n.slug;
    return (
      <g
        key={n.key}
        className={`g-node${selected === slug ? " g-selected" : ""}${dim ? " g-dim" : ""}${ring === "outer" ? " g-outer" : ""}`}
        role="link"
        tabIndex={0}
        aria-label={`${slug}, ${n.type}. Open its graph.`}
        onClick={() => go(slug)}
        onKeyDown={(ev) => { if (ev.key === "Enter") go(slug); }}
        onFocus={() => setSelected(slug)}
        onMouseEnter={() => setSelected(slug)}
      >
        <title>{slug}</title>
        <circle cx={n.x} cy={n.y} r={ring === "outer" ? NODE_R - 2 : NODE_R} className={`gk${ci}`} />
        <text x={lx} y={ly} dy="0.35em" textAnchor={right ? "start" : "end"}>{n.label}</text>
      </g>
    );
  };

  const viewBox = mini ? "120 120 360 360" : "0 0 600 600";

  return (
    <div className={`radial${mini ? " radial-mini" : ""}`}>
      {!mini && onExpand && (
        <div className="radial-bar" aria-live="polite">
          {selected ? (
            <>
              <span className="mono radial-sel" title={selected}>{selected}</span>
              <button className="btn btn-secondary btn-sm" disabled={expandState === "loading"} onClick={() => expand(selected)}>
                {expandState === "loading" ? "Expanding…" : expanded?.slug === selected ? "Expanded" : "Expand"}
              </button>
              <a className="btn btn-secondary btn-sm" href={buildHash({ name: "page", param: selected })}>Open page</a>
              {expanded && <button className="btn-link" onClick={() => setExpanded(null)}>Collapse</button>}
              {expandState === "error" && <span className="error-text">Could not load its neighbors.</span>}
            </>
          ) : (
            <span className="muted">Hover or focus a node to expand it. Click to re-centre.</span>
          )}
        </div>
      )}
      <svg viewBox={viewBox} className="radial-svg" role="group" aria-label={`Link graph around ${center}`}>
        <defs>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((k) => (
            <marker key={k} id={`arrow-${k}${mini ? "-m" : ""}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" className={`gk${k}`} />
            </marker>
          ))}
        </defs>
        <circle cx={C} cy={C} r={radius} className="g-ring" />
        {expanded && <circle cx={C} cy={C} r={OUTER_R} className="g-ring g-ring-outer" />}
        {[...layout.edges, ...outer.edges].map((e) => {
          const ci = colorIndex(allTypes, e.type);
          const s = shorten(e.from, e.to, NODE_R);
          return (
            <line
              key={e.key}
              {...s}
              className={`g-edge gk${ci}`}
              markerEnd={`url(#arrow-${ci}${mini ? "-m" : ""})`}
            />
          );
        })}
        {layout.nodes.map((n) => renderNode(n, "inner"))}
        {outer.nodes.map((n) => renderNode(n, "outer"))}
        <g className="g-center">
          <title>{center}</title>
          <circle cx={C} cy={C} r={NODE_R + 5} />
          <text x={C} y={C + NODE_R + 20} textAnchor="middle">{lastSegment(center, 24)}</text>
        </g>
      </svg>
      {allTypes.length > 0 && (
        <ul className="legend" aria-label="Link types">
          {allTypes.map((t) => (
            <li key={t}><span className={`swatch gk${colorIndex(allTypes, t)}`} />{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
