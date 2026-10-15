import React, { useEffect, useState } from "react";
import { tool } from "../api.ts";
import { describeError, useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { Highlight } from "../components/Highlight.tsx";
import { parseSearch } from "../lib/tool-result.ts";
import type { SearchHit } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

const K = 20;
const MAX_OFFSET = 100;

export function SearchPage({ query }: { query: string | null }) {
  const q = (query ?? "").trim();
  const [draft, setDraft] = useState(q);
  const [extra, setExtra] = useState<SearchHit[]>([]);
  const [more, setMore] = useState<{ status: "idle" | "loading" | "done" | "error"; error: string }>({ status: "idle", error: "" });

  useEffect(() => { setDraft(q); setExtra([]); setMore({ status: "idle", error: "" }); }, [q]);

  const first = useAsync(async (signal) => parseSearch(await tool("search", { q, k: K }, signal)), [q], { enabled: q !== "" });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (next === "") return;
    if (next === q) first.reload();
    else window.location.hash = buildHash({ name: "search", param: next });
  };

  const loadMore = async () => {
    const offset = (first.data?.hits.length ?? 0) + extra.length;
    if (offset > MAX_OFFSET) return;
    setMore({ status: "loading", error: "" });
    try {
      const r = parseSearch(await tool("search", { q, k: K, offset }));
      setExtra((prev) => [...prev, ...r.hits]);
      setMore({ status: r.hits.length < K ? "done" : "idle", error: "" });
    } catch (e) {
      setMore({ status: "error", error: describeError(e) });
    }
  };

  const hits = [...(first.data?.hits ?? []), ...extra];

  return (
    <>
      <h1 className="page-title">Search</h1>
      <form className="search-form" onSubmit={submit} role="search">
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search page text…"
          aria-label="Search query"
          maxLength={200}
          autoFocus
        />
        <button className="btn btn-primary" type="submit" disabled={draft.trim() === ""}>Search</button>
      </form>
      <p className="hint">Hybrid search with every paid stage off. Each query spends one embedding.</p>

      {q === "" ? (
        <div className="empty-note">Enter a query to search the brain.</div>
      ) : (
        <Section state={first} isEmpty={(d) => d.hits.length === 0} emptyText={`No results for “${q}”.`}>
          {(d) => (
            <>
              {d.hint && <div className="notice">{d.hint}</div>}
              <ol className="hits">
                {hits.map((h, i) => (
                  <li key={`${h.chunkId}:${i}`} className="hit">
                    <div className="hit-head">
                      {h.slug ? (
                        <a href={buildHash({ name: "page", param: h.slug })} className="hit-title">{h.title || h.slug}</a>
                      ) : (
                        <span className="hit-title">{h.title || "Untitled source"}</span>
                      )}
                      <span className="hit-score mono" title="Score">{h.score === null ? "—" : h.score.toFixed(3)}</span>
                    </div>
                    <div className="hit-path mono">{h.slug ?? h.sourcePath}</div>
                    <p className="hit-snippet"><Highlight text={h.content.replace(/\s+/g, " ").slice(0, 400)} query={q} /></p>
                  </li>
                ))}
              </ol>
              {more.status === "error" && <div className="tile-error"><span>{more.error}</span></div>}
              {more.status !== "done" && d.hits.length >= K && hits.length <= MAX_OFFSET && (
                <button className="btn btn-secondary" onClick={loadMore} disabled={more.status === "loading"}>
                  {more.status === "loading" ? "Loading…" : "More results"}
                </button>
              )}
            </>
          )}
        </Section>
      )}
    </>
  );
}
