import { stackSeries } from "../../lib/chart.ts";
import { ChartCanvas, toneClass } from "./ChartCanvas.tsx";

export interface BarSeries { key: string; label: string; values: number[]; tone: number }

interface BarChartProps {
  title: string;
  days: string[];
  /** Stacked when there is more than one. */
  series: BarSeries[];
  yFormat: (n: number) => string;
  refLine?: { value: number; label: string };
}

export function BarChart({ title, days, series, yFormat, refLine }: BarChartProps) {
  const stacks = stackSeries(series);
  const dataMax = Math.max(0, ...days.map((_, i) => stacks[stacks.length - 1]?.spans[i]?.[1] ?? 0));
  return (
    <ChartCanvas
      title={title}
      days={days}
      series={series}
      yFormat={yFormat}
      dataMax={dataMax}
      total={series.length > 1}
      {...(refLine ? { refLine } : {})}
      marks={(g, active) => {
        const bw = Math.max(2, Math.min(18, g.band * 0.68));
        return (
          <>
            {active !== null && (
              <rect className="chart-band" x={g.x(active) - g.band / 2} y={g.top} width={g.band} height={g.bottom - g.top} />
            )}
            {stacks.map((s, si) => (
              <g key={s.key} className={toneClass((series[si] as BarSeries).tone)}>
                {s.spans.map(([lo, hi], i) => (hi > lo ? (
                  <rect key={i} className="chart-bar" x={g.x(i) - bw / 2} y={g.y(hi)} width={bw} height={Math.max(1, g.y(lo) - g.y(hi))} />
                ) : null))}
              </g>
            ))}
          </>
        );
      }}
    />
  );
}
