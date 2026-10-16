import { useCallback, useState } from "react";
import { api, tool } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { RadialGraph } from "../components/RadialGraph.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { HBarList } from "../components/charts/HBarList.tsx";
import { parseGraphNeighbors } from "../lib/tool-result.ts";
import type { NeighborEdge } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { fmtInt, lastSegment } from "../lib/format.ts";
import { GRAPH_VIEW_LIMIT, graphTruncated } from "../lib/ring-layout.ts";
import type { GraphHubs } from "../admin-types.ts";

const HUBS = 20;

function neighbors(slug: string, signal?: AbortSignal): Promise<NeighborEdge[]> {
  return tool("graph_neighbors", { slug, direction: "both", limit: GRAPH_VIEW_LIMIT + 1 }, signal).then(parseGraphNeighbors);
}

const hubLabel = (h: GraphHubs["hubs"][number]) => h.title || lastSegment(h.slug, 48);

export function GraphPage({ slug }: { slug: string | null }) {
  if (!slug) return <GraphHome />;
  return <GraphView key={slug} slug={slug} />;
}

function CentreForm() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <h2 className="section-title">Or centre on any page</h2>
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

function GraphHome() {
  const hubs = useAsync<GraphHubs>((s) => api.graphHubs(HUBS, s), []);
  const top = hubs.data?.hubs[0]?.slug ?? null;
  const topEdges = useAsync(async (s) => (top ? neighbors(top, s) : []), [top], { enabled: top !== null });
  const expand = useCallback(
    async (other: string) => parseGraphNeighbors(await tool("graph_neighbors", { slug: other, direction: "both", limit: 20 })),
    [],
  );

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Graph</h1>
          <PageIntro>
            Pages point to each other through <code>[[wikilinks]]</code> in their text and through links agents add with
            the <code>link</code> tool. The graph starts at your most connected pages; click any page to centre on it.
          </PageIntro>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={hubs.reload}>Reload</button>
      </div>

      <Section state={hubs}>
        {(d) => {
          const share = d.total_pages > 0 ? d.linked_pages / d.total_pages : 0;
          if (d.total_links === 0 || d.hubs.length === 0) {
            return (
              <div className="panel graph-empty">
                <p>
                  No links yet. A link is created when a page mentions another with <code>[[other-page]]</code>, or when an
                  agent uses the <code>link</code> tool. Once pages link to each other, the most connected ones appear here.
                </p>
              </div>
            );
          }
          const hub = d.hubs[0] as GraphHubs["hubs"][number];
          return (
            <>
              <p className="graph-stats">
                <span>
                  <strong className="mono">{fmtInt(d.linked_pages)}</strong> of <span className="mono">{fmtInt(d.total_pages)}</span> pages are linked
                  {" · "}<strong className="mono">{fmtInt(d.total_links)}</strong> links
                </span>
                <InfoTip id="graph.linked" />
              </p>
              {share < 0.25 && (
                <p className="hint">
                  Most pages have no links yet, so the graph stays small. Links appear as your notes reference each other
                  with <code>[[wikilinks]]</code>.
                </p>
              )}
              <div className="graph-layout graph-home">
                <section className="panel">
                  <h2 className="panel-title">Most connected pages <InfoTip id="graph.degree" /></h2>
                  <HBarList
                    label="Most connected pages"
                    format={fmtInt}
                    rows={d.hubs.map((h) => ({
                      key: h.slug,
                      label: hubLabel(h),
                      title: h.slug,
                      value: h.degree,
                      href: buildHash({ name: "graph", param: h.slug }),
                      note: `${fmtInt(h.in_degree)} in · ${fmtInt(h.out_degree)} out`,
                    }))}
                  />
                </section>
                <section className="panel graph-panel">
                  <header className="panel-head">
                    <h2 className="panel-title ellipsis-title" title={hub.slug}>Around {hubLabel(hub)}</h2>
                    <a className="panel-link" href={buildHash({ name: "graph", param: hub.slug })}>Open full view</a>
                  </header>
                  <Section state={topEdges} isEmpty={(e) => e.length === 0} emptyText="This page's links could not be listed.">
                    {(e) => <RadialGraph center={hub.slug} edges={e.slice(0, GRAPH_VIEW_LIMIT)} onExpand={expand} />}
                  </Section>
                </section>
              </div>
            </>
          );
        }}
      </Section>
      <CentreForm />
    </>
  );
}

function NoLinks({ slug }: { slug: string }) {
  const hubs = useAsync<GraphHubs>((s) => api.graphHubs(5, s), []);
  const others = (hubs.data?.hubs ?? []).filter((h) => h.slug !== slug).slice(0, 5);
  return (
    <div className="panel graph-empty">
      <p>
        <span className="mono">{slug}</span> has no links yet. Add <code>[[other-page]]</code> to its text, or ask an agent
        to link it.{others.length > 0 && " Try a connected page:"}
      </p>
      {others.length > 0 && (
        <ul className="tags graph-chips">
          {others.map((h) => (
            <li key={h.slug}><a className="tag tag-link" href={buildHash({ name: "graph", param: h.slug })} title={h.slug}>{hubLabel(h)}</a></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GraphView({ slug }: { slug: string }) {
  const edges = useAsync((s) => neighbors(slug, s), [slug]);
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
      <Section state={edges}>
        {(all) => {
          if (all.length === 0) return <NoLinks slug={slug} />;
          const d = all.slice(0, GRAPH_VIEW_LIMIT);
          const pages = new Set(d.map((e) => (e.source_slug === slug ? e.target_slug : e.source_slug))).size;
          return (
            <>
              {graphTruncated(all, GRAPH_VIEW_LIMIT) && (
                <div className="notice">
                  Showing the {GRAPH_VIEW_LIMIT} most recent links. This page has more; the table lists the same {GRAPH_VIEW_LIMIT}.
                </div>
              )}
              <div className="graph-layout">
                <section className="panel graph-panel">
                  <RadialGraph center={slug} edges={d} onExpand={expand} />
                  <p className="hint graph-caption">
                    Colour shows the link type. An arrow points from the page that contains the link to the page it names; a
                    two-headed line means both pages link to each other with the same type.
                  </p>
                </section>
                <section className="panel">
                  <h2 className="panel-title">Neighbours ({fmtInt(pages)} pages, {fmtInt(d.length)} links)</h2>
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
            </>
          );
        }}
      </Section>
    </>
  );
}
