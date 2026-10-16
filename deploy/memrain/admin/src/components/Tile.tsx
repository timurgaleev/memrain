import React from "react";
import type { AsyncState } from "../hooks.ts";
import { describeError } from "../hooks.ts";
import { fmtAgo } from "../lib/format.ts";

interface Props<T> {
  title: string;
  /** Window the figures cover, e.g. "last 24h" or "today (UTC)". */
  window?: string;
  /** A help control placed after the title. */
  help?: React.ReactNode;
  state: AsyncState<T>;
  intervalMs: number;
  now: number;
  isEmpty?: (d: T) => boolean;
  emptyText?: string;
  className?: string;
  children: (d: T) => React.ReactNode;
}

// A panel section with five states: loading (skeleton), empty (says why),
// error (inline, with retry), stale (older than two refreshes: dimmed, with
// its age) and ok. A refresh that fails keeps the last good figures visible.
export function Tile<T>({ title, window: win, help, state, intervalMs, now, isEmpty, emptyText, className, children }: Props<T>) {
  const stale = state.updatedAt !== null && now - state.updatedAt > intervalMs * 2;
  const body = (() => {
    if (state.data === null) {
      if (state.status === "error") {
        return (
          <div className="tile-error">
            <span>{describeError(state.error)}</span>
            <button className="btn-link" onClick={state.reload}>Retry</button>
          </div>
        );
      }
      return (
        <div className="skeleton" aria-busy="true" aria-label="Loading">
          <span /><span /><span />
        </div>
      );
    }
    if (isEmpty?.(state.data)) return <div className="tile-empty">{emptyText ?? "Nothing here yet."}</div>;
    return children(state.data);
  })();
  return (
    <section className={`tile${stale ? " tile-stale" : ""}${className ? ` ${className}` : ""}`}>
      <header className="tile-head">
        <h2 className="tile-title">{title}{help && <> {help}</>}</h2>
        {win && <span className="tile-window">{win}</span>}
      </header>
      {body}
      {state.data !== null && state.status === "error" && (
        <div className="tile-error tile-error-inline">
          <span>{describeError(state.error)}</span>
          <button className="btn-link" onClick={state.reload}>Retry</button>
        </div>
      )}
      {stale && <div className="tile-age">updated {fmtAgo(new Date(state.updatedAt ?? 0).toISOString(), now)}</div>}
    </section>
  );
}

/** Loading / error / empty wrapper for explorer sections (no tile chrome). */
export function Section<T>({ state, isEmpty, emptyText, children }: {
  state: AsyncState<T>;
  isEmpty?: (d: T) => boolean;
  emptyText?: string;
  children: (d: T) => React.ReactNode;
}) {
  if (state.data === null) {
    if (state.status === "error") {
      return (
        <div className="tile-error">
          <span>{describeError(state.error)}</span>
          <button className="btn-link" onClick={state.reload}>Retry</button>
        </div>
      );
    }
    return <div className="skeleton" aria-busy="true" aria-label="Loading"><span /><span /></div>;
  }
  if (isEmpty?.(state.data)) return <div className="empty-note">{emptyText ?? "Nothing here."}</div>;
  return (
    <>
      {state.status === "error" && (
        <div className="tile-error tile-error-inline">
          <span>{describeError(state.error)}</span>
          <button className="btn-link" onClick={state.reload}>Retry</button>
        </div>
      )}
      {children(state.data)}
    </>
  );
}
