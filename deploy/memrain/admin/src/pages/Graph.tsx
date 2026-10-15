import { useCallback, useState } from "react";
import { tool } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { RadialGraph } from "../components/RadialGraph.tsx";
import { parseGraphNeighbors } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

export function GraphPage({ slug }: { slug: string | null }) {
  const [draft, setDraft] = useState("");
  if (!slug) {
    return (
      <>
        <h1 className="page-title">Graph</h1>
        <form
          className="search-form"
          onSubmit={(e) => { e.preventDefault(); if (draft.trim()) window.location.hash = buildHash({ name: "graph", param: draft.trim() }); }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Centre on a slug, e.g. people/alice" aria-label="Centre slug" maxLength={512} />
          <button className="btn btn-primary" type="submit" disabled={draft.trim() === ""}>Show graph</button>
        </form>
        <p className="hint">Or open any page and choose “Graph”.</p>
      </>
    );
  }
  return <GraphView key={slug} slug={slug} />;
}

function GraphView({ slug }: { slug: string }) {
  const edges = useAsync(async (s) => parseGraphNeighbors(await tool("graph_neighbors", { slug, direction: "both", limit: 60 }, s)), [slug]);
  const expand = useCallback(
    async (other: string) => parseGraphNeighbors(await tool("graph_neighbors", { slug: other, direction: "both", limit: 20 })),
    [],
  );

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#graph">Graph</a>
        <span aria-hidden="true">/</span>
        <span className="mono">{slug}</span>
      </nav>
      <div className="page-head">
        <h1 className="page-title">Links around {slug}</h1>
        <div className="page-actions">
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "page", param: slug })}>Page</a>
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "entity", param: slug })}>Entity</a>
        </div>
      </div>
      <Section state={edges} isEmpty={(d) => d.length === 0} emptyText="No links to or from this page.">
        {(d) => (
          <div className="graph-layout">
            <section className="panel graph-panel">
              <RadialGraph center={slug} edges={d} onExpand={expand} />
            </section>
            <section className="panel">
              <h2 className="panel-title">Neighbors ({d.length} links)</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Type</th><th>Dir.</th><th>Other end</th><th className="num">Conf.</th></tr></thead>
                  <tbody>
                    {[...d].sort((a, b) => a.type.localeCompare(b.type)).map((e) => {
                      const other = e.source_slug === slug ? e.target_slug : e.source_slug;
                      return (
                        <tr key={`${e.id}:${e.type}:${e.source_slug}:${e.target_slug}`}>
                          <td className="mono">{e.type}</td>
                          <td className="muted">{e.source_slug === slug ? "→ out" : "← in"}</td>
                          <td>
                            <a href={buildHash({ name: "graph", param: other })} className="mono">{other}</a>
                            {" "}<a href={buildHash({ name: "page", param: other })} className="muted small">page</a>
                          </td>
                          <td className="num mono">{e.confidence === null ? "—" : e.confidence.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </Section>
    </>
  );
}
