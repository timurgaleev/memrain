import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CHART_KEYS, fitSpan, fmtDay, keyIndex, labelIndices, nearestIndex, niceTicks, scaleLinear } from "../../lib/chart.ts";

// Shared frame of the line and bar charts: measured width, axes, hover and
// keyboard inspection, the screen-reader summary and the "Show data" table.
// The SVG draws in CSS pixels, so its text stays the same size at any width.

export const CHART_H = 200;
const M = { left: 44, right: 10, top: 10, bottom: 22 };

export interface CanvasSeries { key: string; label: string; values: (number | null)[]; tone: number | "error" }

export interface Geom {
  w: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  band: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

interface Props {
  title: string;
  days: string[];
  series: CanvasSeries[];
  yFormat: (n: number) => string;
  /** Highest value drawn: the largest point, or the largest stack. */
  dataMax: number;
  refLine?: { value: number; label: string };
  total?: boolean;
  marks: (g: Geom, active: number | null) => React.ReactNode;
}

export const toneClass = (t: number | "error") => (t === "error" ? "ck-error" : `gk${((t - 1) % 8) + 1}`);

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw !== undefined) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function describe(title: string, days: string[], series: CanvasSeries[], yFormat: (n: number) => string): string {
  if (days.length === 0) return `${title}: no data.`;
  const parts = series.map((s) => {
    let best = -1;
    s.values.forEach((v, i) => { if (v !== null && (best === -1 || v > (s.values[best] ?? 0))) best = i; });
    const sum = s.values.reduce<number>((a, v) => a + (v ?? 0), 0);
    return best === -1 ? `${s.label}: no data` : `${s.label} totals ${yFormat(sum)}, highest ${yFormat(s.values[best] ?? 0)} on ${fmtDay(days[best] as string)}`;
  });
  return `${title}, per UTC day from ${fmtDay(days[0] as string)} to ${fmtDay(days[days.length - 1] as string)}. ${parts.join("; ")}.`;
}

export function ChartCanvas({ title, days, series, yFormat, dataMax, refLine, total = false, marks }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const w = useWidth(wrap);
  const titleId = useId();
  const descId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [live, setLive] = useState("");
  const tip = useRef<HTMLDivElement>(null);
  const [tipW, setTipW] = useState(150);
  const n = days.length;

  // A tap pins the nearest day, since touch has no hover; the next tap
  // outside the chart clears it.
  useEffect(() => {
    if (hover === null) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setHover(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [hover]);

  // A cap far above the data would flatten every bar, so it joins the scale
  // only when it is within reach; otherwise the legend says where it is.
  const refInScale = refLine !== undefined && refLine.value > 0 && (dataMax === 0 || refLine.value <= dataMax * 2);
  const ticks = niceTicks(Math.max(dataMax, refInScale && refLine ? refLine.value : 0));
  const yMax = ticks[ticks.length - 1] ?? 1;
  const left = M.left;
  const right = Math.max(left + 1, w - M.right);
  const top = M.top;
  const bottom = CHART_H - M.bottom;
  const band = (right - left) / Math.max(1, n);
  const g: Geom = {
    w, top, bottom, left, right, band,
    x: (i) => left + (i + 0.5) * band,
    y: scaleLinear([0, yMax], [bottom, top]),
  };
  const xs = days.map((_, i) => g.x(i));
  const active = hover ?? focus;

  const pointText = (i: number) => {
    const vals = series.map((s) => `${s.label} ${s.values[i] === null ? "no data" : yFormat(s.values[i] ?? 0)}`);
    if (total) vals.push(`total ${yFormat(series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}`);
    return `${fmtDay(days[i] as string)}: ${vals.join(", ")}`;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!CHART_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = keyIndex(e.key, focus, n);
    setFocus(next);
    setHover(null);
    setLive(next === null ? "" : pointText(next));
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    setHover(nearestIndex(xs, e.clientX - box.left));
  };

  const labels = labelIndices(n, Math.floor(Math.max(1, right - left) / 90));
  useLayoutEffect(() => {
    if (tip.current) setTipW(tip.current.offsetWidth);
  }, [active]);
  // Right of the guide when it fits, else left of it, and never past the chart.
  const tipX = active === null ? 0 : g.x(active);
  const tipLeft = fitSpan(tipX + 12 + tipW <= w - 8 ? tipX + 12 : tipX - 12 - tipW, tipW, 8, w - 8);

  return (
    <>
      {(series.length > 1 || refLine) && (
        <ul className="legend chart-legend" aria-hidden="true">
          {series.length > 1 && series.map((s) => (
            <li key={s.key}><span className={`swatch ${toneClass(s.tone)}`} />{s.label}</li>
          ))}
          {refLine && refLine.value > 0 && (
            <li><span className="swatch-dash" />{refInScale ? refLine.label : `${refLine.label} (above the chart)`}</li>
          )}
        </ul>
      )}
      <div
        ref={wrap}
        className="chart"
        role="group"
        aria-roledescription="chart"
        aria-label={title}
        aria-describedby={descId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setFocus(null)}
      >
        {w > 0 && (
          <svg viewBox={`0 0 ${w} ${CHART_H}`} width={w} height={CHART_H} role="img" aria-labelledby={`${titleId} ${descId}`} className="chart-svg">
            <title id={titleId}>{title}</title>
            <desc id={descId}>{describe(title, days, series, yFormat)}</desc>
            {ticks.map((t) => (
              <g key={t} className="chart-grid">
                <line x1={left} x2={right} y1={g.y(t)} y2={g.y(t)} />
                <text x={left - 6} y={g.y(t)} dy="0.32em" textAnchor="end">{yFormat(t)}</text>
              </g>
            ))}
            {labels.map((i) => (
              <text
                key={i}
                className="chart-xlabel"
                x={i === 0 && n > 1 ? left : i === n - 1 && n > 1 ? right : g.x(i)}
                y={CHART_H - 6}
                textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"}
              >
                {fmtDay(days[i] as string)}
              </text>
            ))}
            {active !== null && <line className="chart-guide" x1={g.x(active)} x2={g.x(active)} y1={top} y2={bottom} />}
            {marks(g, active)}
            {refInScale && refLine && (
              <line className="chart-ref" x1={left} x2={right} y1={g.y(refLine.value)} y2={g.y(refLine.value)} />
            )}
            <rect
              className="chart-hit"
              x={left}
              y={top}
              width={Math.max(0, right - left)}
              height={bottom - top}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={(e) => { if (e.pointerType !== "touch") setHover(null); }}
            />
          </svg>
        )}
        {active !== null && w > 0 && (
          <div ref={tip} className="chart-tip" style={{ left: tipLeft, top }} aria-hidden="true">
            <div className="chart-tip-day">{fmtDay(days[active] as string)}</div>
            {series.map((s) => (
              <div key={s.key} className="chart-tip-row">
                <span className={`swatch ${toneClass(s.tone)}`} />
                <span className="chart-tip-label">{s.label}</span>
                <span className="mono">{s.values[active] === null ? "—" : yFormat(s.values[active] ?? 0)}</span>
              </div>
            ))}
            {total && (
              <div className="chart-tip-row chart-tip-total">
                <span className="chart-tip-label">Total</span>
                <span className="mono">{yFormat(series.reduce((a, s) => a + (s.values[active] ?? 0), 0))}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{live}</div>
      <details className="chart-data">
        <summary>Show data</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                {series.map((s) => <th key={s.key} className="num">{s.label}</th>)}
                {total && <th className="num">Total</th>}
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d}>
                  <td className="mono">{d}</td>
                  {series.map((s) => <td key={s.key} className="num mono">{s.values[i] === null ? "—" : yFormat(s.values[i] ?? 0)}</td>)}
                  {total && <td className="num mono">{yFormat(series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
