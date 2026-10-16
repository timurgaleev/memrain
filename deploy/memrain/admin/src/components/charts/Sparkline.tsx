import { areaPath, linePath, scaleLinear } from "../../lib/chart.ts";

const W = 120;
const H = 28;

/** A decorative trend beside a figure; the figure itself carries the meaning. */
export function Sparkline({ values, tone = 1 }: { values: number[]; tone?: number }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values, 0);
  const x = scaleLinear([0, values.length - 1], [1, W - 1]);
  const y = scaleLinear([0, max || 1], [H - 2, 2]);
  const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
  return (
    <svg className={`spark gk${((tone - 1) % 8) + 1}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false">
      <path className="chart-area" d={areaPath(pts, H - 1)} />
      <path className="chart-line" d={linePath(pts)} />
    </svg>
  );
}
