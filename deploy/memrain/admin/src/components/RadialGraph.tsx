import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NeighborEdge } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { lastSegment } from "../lib/format.ts";
import { NODE_R, OUTER_R, RING_C as C, labelScale, ringLayout } from "../lib/ring-layout.ts";
import type { RingEdge, RingNode } from "../lib/ring-layout.ts";

// One-hop neighborhood as a radial SVG: the centre node, its neighbors on a
// ring grouped by link type into contiguous arcs, and (full page only) one
// expanded node's own neighbors on an outer ring. The positions come from
// lib/ring-layout.ts.

function otherEnd(e: NeighborEdge, center: string): string {
  return e.source_slug === center ? e.target_slug : e.source_slug;
}

function colorIndex(types: string[], t: string): number {
  return (Math.max(0, types.indexOf(t)) % 8) + 1;
}

/**
 * Pull both endpoints in by the node radius so arrowheads stay visible, and
 * shift the line sideways by `offset` (measured against the centre→neighbour
 * direction) so parallel edges of different types do not overlap.
 */
function shorten(e: RingEdge, by: number) {
  const a = e.from;
  const b = e.to;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const sign = a.x === C && a.y === C ? 1 : -1;
  const ox = -uy * e.offset * sign;
  const oy = ux * e.offset * sign;
  const startBy = e.both ? by + 2 : by;
  return { x1: a.x + ux * startBy + ox, y1: a.y + uy * startBy + oy, x2: b.x - ux * (by + 2) + ox, y2: b.y - uy * (by + 2) + oy };
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
  const svg = useRef<SVGSVGElement>(null);
  const [clientW, setClientW] = useState(0);

  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    // The observer reports the content box, which is what the viewBox maps onto.
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw !== undefined) setClientW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const outer = useMemo(() => {
    if (!expanded) return { nodes: [] as RingNode[], edges: [] as RingEdge[] };
    const anchor = layout.nodes.find((n) => n.slug === expanded.slug);
    if (!anchor) return { nodes: [], edges: [] };
    const taken = new Set([center, ...layout.nodes.map((n) => n.slug ?? "")]);
    const others = [...new Map(expanded.edges.map((e) => [otherEnd(e, expanded.slug), e])).entries()]
      .filter(([s]) => !taken.has(s) && s !== "")
      .slice(0, 20);
    const spread = Math.min(Math.PI / 2, 0.16 * others.length);
    const nodes: RingNode[] = others.map(([s, e], i) => {
      const angle = anchor.angle - spread / 2 + (others.length > 1 ? (spread * i) / (others.length - 1) : 0);
      return { key: `o:${s}`, slug: s, label: lastSegment(s, 14), type: e.type, angle, x: C + OUTER_R * Math.cos(angle), y: C + OUTER_R * Math.sin(angle) };
    });
    const oedges: RingEdge[] = nodes.map((n, i) => {
      const e = (others[i] as [string, NeighborEdge])[1];
      const out = e.source_slug === expanded.slug;
      return { key: `oe:${n.key}`, type: e.type, from: out ? anchor : n, to: out ? n : anchor, both: false, offset: 0 };
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

  const renderNode = (n: RingNode, ring: "inner" | "outer") => {
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

  // The full view leaves room on both sides so long labels are not clipped.
  const viewBox = mini ? "120 120 360 360" : "-80 0 760 600";
  // Labels keep a readable size as the drawing shrinks; on a phone they give
  // way to the selected-node bar and each node's tooltip.
  const label = labelScale(mini ? 360 : 760, clientW, mini ? 11 : 12);

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
      <svg
        ref={svg}
        viewBox={viewBox}
        className={`radial-svg${label.hide ? " g-nolabels" : ""}`}
        style={{ "--g-scale": label.scale } as CSSProperties}
        role="group" aria-label={`Link graph around ${center}`}>
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
          const s = shorten(e, NODE_R);
          const marker = `url(#arrow-${ci}${mini ? "-m" : ""})`;
          return (
            <line
              key={e.key}
              {...s}
              className={`g-edge gk${ci}`}
              markerEnd={marker}
              {...(e.both ? { markerStart: marker } : {})}
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
