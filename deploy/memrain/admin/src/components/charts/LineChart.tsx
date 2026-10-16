import { areaPath, linePath } from "../../lib/chart.ts";
import { ChartCanvas, toneClass } from "./ChartCanvas.tsx";

export interface LineSeries { key: string; label: string; values: (number | null)[]; tone: number | "error"; area?: boolean }

interface LineChartProps {
  title: string;
  days: string[];
  series: LineSeries[];
  yFormat: (n: number) => string;
  refLine?: { value: number; label: string };
}

export function LineChart({ title, days, series, yFormat, refLine }: LineChartProps) {
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  return (
    <ChartCanvas
      title={title}
      days={days}
      series={series}
      yFormat={yFormat}
      dataMax={dataMax}
      {...(refLine ? { refLine } : {})}
      marks={(g, active) => (
        <>
          {series.map((s) => {
            const pts = s.values.map((v, i) => (v === null ? null : { x: g.x(i), y: g.y(v) }));
            return (
              <g key={s.key} className={toneClass(s.tone)}>
                {s.area && <path className="chart-area" d={areaPath(pts, g.bottom)} />}
                <path className="chart-line" d={linePath(pts)} />
              </g>
            );
          })}
          {active !== null && series.map((s) => {
            const v = s.values[active];
            return v === null || v === undefined ? null : (
              <circle key={s.key} className={`chart-dot ${toneClass(s.tone)}`} cx={g.x(active)} cy={g.y(v)} r={3.5} />
            );
          })}
        </>
      )}
    />
  );
}
