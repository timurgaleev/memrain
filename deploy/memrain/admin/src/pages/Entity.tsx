import { useState } from "react";
import { tool } from "../api.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { fmtAgo } from "../lib/format.ts";
import { parseEntityRecall, parseFacts, parseRecall } from "../lib/tool-result.ts";
import type { Fact } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { PageIntro } from "../components/PageIntro.tsx";

export function EntityPage({ slug }: { slug: string | null }) {
  const [draft, setDraft] = useState("");
  if (!slug) {
    return (
      <>
        <h1 className="page-title">Entities and facts</h1>
        <PageIntro>
          An entity is something the brain knows facts about: a person, company, project or topic. Facts are short claims,
          extracted from pages or recorded directly, each with its date and, when it has one, its source page.
        </PageIntro>
        <form
          className="search-form"
          onSubmit={(e) => { e.preventDefault(); if (draft.trim()) window.location.hash = buildHash({ name: "entity", param: draft.trim() }); }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Entity slug, e.g. people/alice" aria-label="Entity slug" maxLength={512} />
          <button className="btn btn-primary" type="submit" disabled={draft.trim() === ""}>Open</button>
        </form>
        <p className="hint">Or open any page and choose “Entity”. <kbd>⌘K</kbd> finds slugs.</p>
      </>
    );
  }
  return <EntityView key={slug} slug={slug} />;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function EntityView({ slug }: { slug: string }) {
  const now = useNow(30_000);
  const [focusDraft, setFocusDraft] = useState("");
  const [focus, setFocus] = useState("");
  const recall = useAsync(async (s) => parseEntityRecall(await tool("entity_recall", {
    slug, fact_limit: 50, timeline_limit: 50, ...(focus ? { query: focus } : {}),
  }, s)), [slug, focus]);
  const superseded = useAsync(async (s) => parseFacts(await tool("fact_supersessions", { entity_slug: slug, limit: 100 }, s), "supersessions"), [slug]);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#entity">Entities</a>
        <span aria-hidden="true">/</span>
        <span className="mono">{slug}</span>
      </nav>
      <div className="page-head">
        <h1 className="page-title">{recall.data?.page?.title || slug}</h1>
        <div className="page-actions">
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "page", param: slug })}>Page</a>
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "graph", param: slug })}>Graph</a>
        </div>
      </div>

      <form className="search-form" onSubmit={(e) => { e.preventDefault(); setFocus(focusDraft.trim()); }}>
        <input
          value={focusDraft}
          onChange={(e) => setFocusDraft(e.target.value)}
          placeholder="Focus facts on a topic (optional)"
          aria-label="Focus query"
          maxLength={200}
        />
        <button className="btn btn-secondary" type="submit">Focus</button>
        {focus && <button className="btn-link" type="button" onClick={() => { setFocus(""); setFocusDraft(""); }}>Clear</button>}
      </form>
      <p className="hint">Focus is semantic and uses one embedding per query.</p>

      <h2 className="section-title">Facts{focus ? `, focused on “${focus}”` : ""}</h2>
      <section className="panel">
        <Section state={recall} isEmpty={(d) => d.facts.length === 0} emptyText="No live facts for this entity.">
          {(d) => (
            <>
              {d.pendingConsolidation !== null && d.pendingConsolidation > 0 && (
                <div className="notice">{d.pendingConsolidation} facts are waiting for consolidation.</div>
              )}
              <FactsTable facts={d.facts} />
            </>
          )}
        </Section>
      </section>

      <h2 className="section-title">Timeline</h2>
      <section className="panel">
        <Section state={recall} isEmpty={(d) => d.timeline.length === 0} emptyText="No timeline events.">
          {(d) => (
            <ol className="timeline">
              {d.timeline.map((t, i) => (
                <li key={`${t.id}:${i}`}>
                  <time className="mono muted" dateTime={t.occurred_at ?? undefined}>{day(t.occurred_at)}</time>
                  <div>
                    <div>{t.event}</div>
                    {t.detail && <div className="muted small">{t.detail}</div>}
                    {t.source_label && <div className="muted small mono">{t.source_label}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </section>

      <h2 className="section-title">Superseded facts</h2>
      <section className="panel">
        <Section state={superseded} isEmpty={(d) => d.length === 0} emptyText="Nothing has been superseded.">
          {(rows) => (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Old fact</th><th>Written</th><th>Replaced by</th></tr></thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id}>
                      <td className="muted strike-soft">{f.fact}</td>
                      <td className="muted" title={f.written_at ?? undefined}>{fmtAgo(f.written_at, now)}</td>
                      <td>{f.superseded_by ? <Successor id={f.superseded_by} /> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </section>
    </>
  );
}

function FactsTable({ facts }: { facts: Fact[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Fact</th><th className="num">Conf.</th><th>Kind</th><th>Valid</th><th>Visibility</th><th>Written</th></tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id}>
              <td className="fact-cell">
                {f.fact}
                {f.source_slug && <a className="muted small mono fact-source" href={buildHash({ name: "page", param: f.source_slug })}>{f.source_slug}</a>}
              </td>
              <td className="num mono">{f.confidence === null ? "—" : f.confidence.toFixed(2)}</td>
              <td className="mono">{f.kind ?? "—"}</td>
              <td className="mono small">{f.valid_from || f.valid_until ? `${day(f.valid_from)} → ${f.valid_until ? day(f.valid_until) : "now"}` : "—"}</td>
              <td className="mono small">{f.visibility ?? "—"}</td>
              <td className="mono small">{day(f.written_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Successor({ id }: { id: string }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "error"; fact: Fact | null; error: string }>({ status: "idle", fact: null, error: "" });
  const load = async () => {
    setState({ status: "loading", fact: null, error: "" });
    try {
      const fact = parseRecall(await tool("recall", { id }));
      setState({ status: "ok", fact, error: "" });
    } catch (e) {
      setState({ status: "error", fact: null, error: describeError(e) });
    }
  };
  if (state.status === "ok") return <span>{state.fact?.fact ?? <span className="muted">fact #{id} not found</span>}</span>;
  return (
    <span>
      <button className="btn-link mono" onClick={load} disabled={state.status === "loading"}>
        {state.status === "loading" ? "loading…" : `fact #${id}`}
      </button>
      {state.status === "error" && <span className="error-text small"> {state.error}</span>}
    </span>
  );
}
