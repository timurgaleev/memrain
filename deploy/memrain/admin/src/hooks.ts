import { useCallback, useEffect, useRef, useState } from "react";
import { ToolError, ToolShapeError } from "./lib/tool-result.ts";

export type AsyncStatus = "loading" | "ok" | "error";

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: unknown;
  /** ms epoch of the last successful load; null before the first. */
  updatedAt: number | null;
  reload: () => void;
}

/**
 * Loads `fn` when `deps` change and, with `intervalMs`, polls while the tab is
 * visible (one catch-up fetch when it becomes visible again). A failed refresh
 * keeps the previous data so a tile can show it as stale beside the error; the
 * next success clears the error. A superseded request is aborted and its
 * answer ignored.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { intervalMs?: number; enabled?: boolean } = {},
): AsyncState<T> {
  const { intervalMs, enabled = true } = opts;
  const [state, setState] = useState<Omit<AsyncState<T>, "reload">>({
    status: "loading", data: null, error: null, updatedAt: null,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const mine = ++seq.current;
    setState((s) => (s.data === null ? { ...s, status: "loading" } : s));
    fnRef.current(c.signal).then(
      (data) => {
        if (mine !== seq.current) return;
        setState({ status: "ok", data, error: null, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (mine !== seq.current || c.signal.aborted) return;
        setState((s) => ({ ...s, status: "error", error }));
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setState({ status: "loading", data: null, error: null, updatedAt: null });
    run();
    let timer: ReturnType<typeof setInterval> | undefined;
    const onVisible = () => { if (!document.hidden) run(); };
    if (intervalMs) {
      timer = setInterval(() => { if (!document.hidden) run(); }, intervalMs);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ctrl.current?.abort();
      seq.current += 1;
    };
  }, [...deps, enabled, intervalMs]);

  return { ...state, reload: run };
}

/** One readable line for any failure the panel can hit. */
export function describeError(e: unknown): string {
  if (e instanceof ToolError) {
    if (e.code === "rate_limited") return `Search paused, try again in ${e.retryAfterS ?? 2}s.`;
    if (e.code === "unauthorized") return "Session expired. Sign in again.";
    const base = e.message && e.message !== e.code ? `${e.code}: ${e.message}` : e.code;
    return e.suggestion ? `${base}. ${e.suggestion}` : base;
  }
  if (e instanceof ToolShapeError) return "The server answered in an unexpected shape.";
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Keeps a value only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(setV, ms, value);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A clock that ticks so "updated Xs ago" labels stay current. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
