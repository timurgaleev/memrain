import React, { useEffect, useMemo, useRef, useState } from "react";
import { tool } from "../api.ts";
import { describeError, useDebounced } from "../hooks.ts";
import { parseResolveSlugs, parseSearch } from "../lib/tool-result.ts";
import type { SearchHit, SlugHit } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

// ⌘K: slug matches first (cheap, trigram), semantic search hits appended
// below once the query is long enough. Each group has its own abort
// controller and sequence number, so a slow answer to an older query can
// never overwrite a newer one, and appending search rows never moves the
// highlighted row.

interface Row {
  id: string;
  group: "pages" | "search";
  slug: string | null;
  primary: string;
  secondary: string;
}

interface Group<T> {
  status: "idle" | "loading" | "ok" | "error";
  items: T[];
  error: string;
}

const IDLE = { status: "idle" as const, items: [], error: "" };

function useGroup<T>(
  query: string,
  minChars: number,
  load: (q: string, signal: AbortSignal) => Promise<T[]>,
): Group<T> {
  const [g, setG] = useState<Group<T>>(IDLE);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (q.length < minChars) {
      setG(IDLE);
      return;
    }
    const c = new AbortController();
    setG((prev) => ({ ...prev, status: "loading", error: "" }));
    loadRef.current(q, c.signal).then(
      (items) => { if (mine === seq.current) setG({ status: "ok", items, error: "" }); },
      (e: unknown) => {
        if (mine !== seq.current || c.signal.aborted) return;
        setG({ status: "error", items: [], error: describeError(e) });
      },
    );
    return () => c.abort();
  }, [query, minChars]);
  return g;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  const slugQuery = useDebounced(open ? input : "", 120);
  const searchQuery = useDebounced(open ? input : "", 250);

  const pages = useGroup<SlugHit>(slugQuery, 1, async (q, signal) =>
    parseResolveSlugs(await tool("resolve_slugs", { query: q, limit: 8 }, signal)));
  const search = useGroup<SearchHit>(searchQuery, 3, async (q, signal) =>
    parseSearch(await tool("search", { q, k: 8 }, signal)).hits);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = pages.items.map((h) => ({
      id: `p:${h.slug}`, group: "pages", slug: h.slug, primary: h.title || h.slug, secondary: h.slug,
    }));
    const seen = new Set(out.map((r) => r.slug));
    for (const h of search.items) {
      if (h.slug && seen.has(h.slug)) continue;
      if (h.slug) seen.add(h.slug);
      out.push({
        id: `s:${h.chunkId || h.sourcePath}`,
        group: "search",
        slug: h.slug,
        primary: h.title || h.slug || h.sourcePath,
        secondary: h.content.replace(/\s+/g, " ").slice(0, 120),
      });
    }
    return out;
  }, [pages.items, search.items]);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      setInput("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
      opener.current = null;
    }
  }, [open]);

  // The highlight follows the row it sits on, not its index, when slug
  // results change underneath it.
  const activeId = rows[Math.min(active, Math.max(0, rows.length - 1))]?.id;
  useEffect(() => { setActive(0); }, [slugQuery]);

  if (!open) return null;

  const choose = (r: Row | undefined) => {
    if (!r || !r.slug) return;
    window.location.hash = buildHash({ name: "page", param: r.slug });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows.length === 0 && input.trim().length >= 3) {
        window.location.hash = buildHash({ name: "search", param: input.trim() });
        onClose();
      } else {
        choose(rows[active]);
      }
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>("input, button, [href]");
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const typed = input.trim();
  const searchPaused = search.status === "error" && search.error.startsWith("Search paused");
  const renderRow = (r: Row, i: number) => (
    <li
      key={r.id}
      id={`cmdk-${i}`}
      role="option"
      aria-selected={r.id === activeId}
      aria-disabled={!r.slug}
      className={`cmdk-row${r.id === activeId ? " active" : ""}${r.slug ? "" : " cmdk-row-off"}`}
      onMouseMove={() => setActive(i)}
      onClick={() => choose(r)}
    >
      <span className="cmdk-primary">{r.primary}</span>
      <span className="cmdk-secondary">{r.secondary}</span>
      {r.group === "search" && <span className="cmdk-tag">semantic</span>}
    </li>
  );
  const pageRows = rows.filter((r) => r.group === "pages");
  const searchRows = rows.filter((r) => r.group === "search");

  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a page"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Jump to a page or search the brain…"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="cmdk-list"
          aria-activedescendant={rows.length > 0 ? `cmdk-${rows.findIndex((r) => r.id === activeId)}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
        />
        <ul id="cmdk-list" role="listbox" className="cmdk-list" aria-label="Results">
          {typed === "" ? (
            <li className="cmdk-hint">Type a slug or a phrase. Search starts at three characters.</li>
          ) : (
            <>
              <li className="cmdk-group" role="presentation">
                Pages
                {pages.status === "loading" && <span className="cmdk-status">searching…</span>}
              </li>
              {pages.status === "error" && <li className="cmdk-error" role="presentation">{pages.error}</li>}
              {pages.status === "ok" && pageRows.length === 0 && <li className="cmdk-none" role="presentation">No matching slugs.</li>}
              {pageRows.map((r) => renderRow(r, rows.indexOf(r)))}
              <li className="cmdk-group" role="presentation">
                Search
                {search.status === "loading" && <span className="cmdk-status">searching…</span>}
              </li>
              {typed.length < 3 && <li className="cmdk-none" role="presentation">Keep typing to search page text.</li>}
              {search.status === "error" && (
                <li className={searchPaused ? "cmdk-none" : "cmdk-error"} role="presentation">{search.error}</li>
              )}
              {search.status === "ok" && searchRows.length === 0 && <li className="cmdk-none" role="presentation">No other hits.</li>}
              {searchRows.map((r) => renderRow(r, rows.indexOf(r)))}
            </>
          )}
        </ul>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
