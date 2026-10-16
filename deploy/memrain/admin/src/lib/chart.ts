// Geometry for the hand-drawn SVG charts. Pure functions, no DOM, so the root
// test runner can load them.

const NICE = [1, 2, 5, 10];

/** Ascending ticks from 0 that cover `max` in steps of 1, 2 or 5 × 10ⁿ. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE.find((n) => n * mag >= raw) ?? 10) * mag;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const n = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(Number((i * step).toFixed(decimals)));
  return ticks;
}

export function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

type Pt = { x: number; y: number } | null;

function segments(points: Pt[]): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A polyline path that breaks at null points instead of bridging the gap. */
export function linePath(points: Pt[]): string {
  return segments(points)
    .map((seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)},${r2(p.y)}`).join(""))
    .join("");
}

/** Filled area under each non-null run, each closed to the baseline on its own. */
export function areaPath(points: Pt[], baselineY: number): string {
  return segments(points)
    .map((seg) => {
      const first = seg[0] as { x: number; y: number };
      const last = seg[seg.length - 1] as { x: number; y: number };
      const top = seg.map((p) => `L${r2(p.x)},${r2(p.y)}`).join("");
      return `M${r2(first.x)},${r2(baselineY)}${top}L${r2(last.x)},${r2(baselineY)}Z`;
    })
    .join("");
}

/** Cumulative [bottom, top] per value, series stacked in the given order. */
export function stackSeries(series: { key: string; values: number[] }[]): { key: string; spans: [number, number][] }[] {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const base = Array.from<number>({ length: n }).fill(0);
  return series.map((s) => ({
    key: s.key,
    spans: base.map((b, i) => {
      const v = Math.max(0, s.values[i] ?? 0);
      base[i] = b + v;
      return [b, b + v] as [number, number];
    }),
  }));
}

/** Index of the x closest to `x`; the lower index wins a tie. */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs((xs[i] as number) - x) < Math.abs((xs[best] as number) - x)) best = i;
  }
  return best;
}

/** Relative change, or null when there is nothing earlier to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return (cur - prev) / prev;
}

/** Keyboard model of a chart: arrows step, Home/End jump, Escape clears. */
export function keyIndex(key: string, cur: number | null, n: number): number | null {
  if (n <= 0 || key === "Escape") return null;
  switch (key) {
    case "ArrowRight": return cur === null ? 0 : Math.min(n - 1, cur + 1);
    case "ArrowLeft": return cur === null ? n - 1 : Math.max(0, cur - 1);
    case "Home": return 0;
    case "End": return n - 1;
    default: return cur;
  }
}

export const CHART_KEYS: ReadonlySet<string> = new Set(["ArrowRight", "ArrowLeft", "Home", "End", "Escape"]);

const DAY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** 'YYYY-MM-DD' → 'Mar 4' (the bucket is a UTC day). */
export function fmtDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? DAY_FMT.format(t) : day;
}

/** Evenly spaced label indices, always including the last one. */
export function labelIndices(n: number, maxLabels: number): number[] {
  if (n <= 0) return [];
  const k = Math.max(1, Math.min(n, Math.floor(maxLabels)));
  if (k === 1) return [n - 1];
  const step = Math.ceil((n - 1) / (k - 1));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

export function fmtPct(change: number | null): string {
  if (change === null) return "no earlier data";
  const v = Math.round(change * 100);
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}%`;
}

/** Start of a span of `size` placed at `start`, moved back inside [lo, hi]. */
export function fitSpan(start: number, size: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(start, hi - size));
}

/**
 * Headline of a day series whose last bucket is today and still filling: the
 * total counts every bucket, the change compares completed days only.
 */
export function partialDayTotals(values: number[], prevCompleted: number): { total: number; change: number | null } {
  const total = values.reduce((a, v) => a + v, 0);
  const completed = total - (values[values.length - 1] ?? 0);
  return { total, change: pctChange(completed, prevCompleted) };
}
