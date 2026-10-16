import React from "react";
import type { AsyncState } from "../../hooks.ts";
import { Section } from "../Tile.tsx";
import { InfoTip } from "../InfoTip.tsx";
import type { MetricId } from "../../lib/glossary.ts";
import { fmtAgo } from "../../lib/format.ts";

interface ChartFrameProps<T> {
  title: string;
  help: MetricId;
  state: AsyncState<T>;
  isEmpty: (d: T) => boolean;
  /** Says why the chart is empty and what fills it. */
  empty: React.ReactNode | ((d: T) => React.ReactNode);
  summary?: (d: T) => React.ReactNode;
  /** A caveat under the summary, shown with the chart. */
  note?: (d: T) => React.ReactNode;
  /** With both, a frame older than two refreshes dims and shows its age. */
  now?: number;
  intervalMs?: number;
  children: (d: T) => React.ReactNode;
}

// A chart panel: title with its help, a one-line summary, and the loading,
// error, empty and stale states from Section.
export function ChartFrame<T>({ title, help, state, isEmpty, empty, summary, note, now, intervalMs, children }: ChartFrameProps<T>) {
  const stale = now !== undefined && intervalMs !== undefined && state.updatedAt !== null && now - state.updatedAt > intervalMs * 2;
  const d = state.data;
  return (
    <section className={`panel chart-panel${stale ? " tile-stale" : ""}`}>
      <header className="chart-head">
        <h2 className="panel-title">{title} <InfoTip id={help} /></h2>
        {d !== null && summary && !isEmpty(d) && <p className="chart-summary">{summary(d)}</p>}
        {d !== null && note && !isEmpty(d) && note(d) && <p className="hint chart-note">{note(d)}</p>}
      </header>
      <Section state={state}>
        {(data) => (isEmpty(data)
          ? <div className="chart-empty">{typeof empty === "function" ? (empty as (x: T) => React.ReactNode)(data) : empty}</div>
          : children(data))}
      </Section>
      {stale && now !== undefined && <div className="tile-age">updated {fmtAgo(new Date(state.updatedAt ?? 0).toISOString(), now)}</div>}
    </section>
  );
}
