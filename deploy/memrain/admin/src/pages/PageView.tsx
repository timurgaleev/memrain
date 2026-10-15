import React, { useCallback, useEffect, useState } from "react";
import { tool } from "../api.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import type { AsyncState } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { RadialGraph } from "../components/RadialGraph.tsx";
import { Toast } from "../components/Toast.tsx";
import type { ToastSpec } from "../components/Toast.tsx";
import { fmtAgo } from "../lib/format.ts";
import {
  parseGetLinks, parseGetTags, parseGraphNeighbors, parsePageGet, parsePageVersions, parseTagWrite,
} from "../lib/tool-result.ts";
import type { LinkGroup } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

let toastSeq = 0;

export function PageViewPage({ slug }: { slug: string | null }) {
  if (!slug) {
    return (
      <>
        <h1 className="page-title">Page</h1>
        <div className="empty-note">No page selected. Open one from <a href="#pages">Pages</a> or press <kbd>⌘K</kbd>.</div>
      </>
    );
  }
  return <PageView key={slug} slug={slug} />;
}

function PageView({ slug }: { slug: string }) {
  const now = useNow(30_000);
  const page = useAsync(async (s) => parsePageGet(await tool("page_get", { slug }, s)), [slug]);
  const tags = useAsync(async (s) => parseGetTags(await tool("get_tags", { slug }, s)), [slug]);
  const links = useAsync(async (s) => parseGetLinks(await tool("get_links", { slug, limit: 200 }, s)), [slug]);
  const versions = useAsync(async (s) => parsePageVersions(await tool("page_versions", { slug, limit: 10 }, s)), [slug]);
  const neighbors = useAsync(async (s) => parseGraphNeighbors(await tool("graph_neighbors", { slug, direction: "both", limit: 20 }, s)), [slug]);
  const [raw, setRaw] = useState(false);
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  const p = page.data?.kind === "page" ? page.data : null;
  const title = p?.page.title || slug;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#pages">Pages</a>
        <span aria-hidden="true">/</span>
        <span className="mono">{slug}</span>
      </nav>
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        <div className="page-actions">
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "entity", param: slug })}>Entity</a>
          <a className="btn btn-secondary btn-sm" href={buildHash({ name: "graph", param: slug })}>Graph</a>
        </div>
      </div>

      <div className="page-layout">
        <div className="page-main">
          <Section state={page}>
            {(d) => d.kind === "ambiguous" ? (
              <div className="panel">
                <h2 className="panel-title">“{slug}” matches more than one page</h2>
                {d.candidates.length === 0 ? <div className="empty-note">No candidates were returned.</div> : (
                  <ul className="link-list">
                    {d.candidates.map((c) => <li key={c}><a href={buildHash({ name: "page", param: c })} className="mono">{c}</a></li>)}
                  </ul>
                )}
              </div>
            ) : (
              <article className="panel">
                <div className="meta-row">
                  {d.page.type && <span className="badge badge-read">{d.page.type}</span>}
                  {d.quarantined && <span className="badge badge-admin" title="This page is quarantined">quarantined</span>}
                  <span className="muted">v{d.version}</span>
                  {d.page.updated_at && <span className="muted" title={d.page.updated_at}>updated {fmtAgo(d.page.updated_at, now)}</span>}
                  {d.page.source_id && <span className="muted mono">source {d.page.source_id}</span>}
                  <span className="spacer" />
                  <div className="segmented segmented-sm" role="group" aria-label="Body view">
                    <button className={!raw ? "active" : ""} aria-pressed={!raw} onClick={() => setRaw(false)}>Rendered</button>
                    <button className={raw ? "active" : ""} aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
                  </div>
                </div>
                {raw ? <pre className="raw">{d.page.markdown_body}</pre> : <Markdown source={d.page.markdown_body} />}
              </article>
            )}
          </Section>

          <h2 className="section-title">Versions</h2>
          <section className="panel">
            <Section state={versions} isEmpty={(d) => d.length === 0} emptyText="No earlier versions recorded.">
              {(rows) => (
                <ul className="versions">
                  {rows.map((v, i) => (
                    <li key={`${v.version_n ?? "x"}:${i}`}>
                      <div className="version-row">
                        <span className="mono">v{v.version_n ?? "?"}</span>
                        <span className="mono muted">{v.written_by ?? "unknown"}</span>
                        <span className="muted" title={v.written_at ?? undefined}>{fmtAgo(v.written_at, now)}</span>
                        <span className="spacer" />
                        <button className="btn-link" aria-expanded={openVersion === i} onClick={() => setOpenVersion(openVersion === i ? null : i)}>
                          {openVersion === i ? "Hide" : "View"}
                        </button>
                      </div>
                      {openVersion === i && (
                        <div className="version-body">
                          <Markdown source={v.body_snapshot} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <p className="hint">History is read-only here.</p>
          </section>
        </div>

        <aside className="page-side">
          <section className="panel">
            <h2 className="panel-title">Tags</h2>
            <TagEditor slug={slug} state={tags} />
          </section>

          <section className="panel">
            <h2 className="panel-title">Neighbors</h2>
            <Section state={neighbors} isEmpty={(d) => d.length === 0} emptyText="No links to or from this page.">
              {(edges) => <RadialGraph center={slug} edges={edges} mini />}
            </Section>
          </section>

          <section className="panel">
            <h2 className="panel-title">Links</h2>
            <Section state={links} isEmpty={(d) => d.every((g) => g.links.length === 0)} emptyText="No links recorded.">
              {(groups) => <LinkGroups slug={slug} groups={groups} />}
            </Section>
          </section>
        </aside>
      </div>
    </>
  );
}

function LinkGroups({ slug, groups }: { slug: string; groups: LinkGroup[] }) {
  const sorted = [...groups].filter((g) => g.links.length > 0)
    .sort((a, b) => a.direction.localeCompare(b.direction) || a.type.localeCompare(b.type));
  return (
    <div className="link-groups">
      {sorted.map((g) => (
        <div key={`${g.direction}:${g.type}`} className="link-group">
          <div className="link-group-head">
            <span className="mono">{g.type}</span>
            <span className="muted">{g.direction === "outbound" ? "→ out" : "← in"} · {g.links.length}</span>
          </div>
          <ul className="link-list compact">
            {g.links.map((l) => {
              const other = g.direction === "outbound" ? l.target_slug : l.source_slug;
              const target = other === slug ? (g.direction === "outbound" ? l.source_slug : l.target_slug) : other;
              return (
                <li key={`${l.id}:${target}`}>
                  <a href={buildHash({ name: "page", param: target })} className="mono" title={l.context ?? target}>{target}</a>
                  {l.confidence !== null && l.confidence < 1 && <span className="muted ll-meta">{l.confidence.toFixed(2)}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TagEditor({ slug, state }: { slug: string; state: AsyncState<string[]> }) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastSpec | null>(null);

  useEffect(() => { if (state.data) setTags(state.data); }, [state.data]);
  const closeToast = useCallback(() => setToast(null), []);

  const write = async (name: "add_tag" | "remove_tag", tag: string): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      parseTagWrite(await tool(name, { slug, tag }));
      setTags((prev) => {
        const base = prev ?? [];
        return name === "add_tag" ? (base.includes(tag) ? base : [...base, tag]) : base.filter((t) => t !== tag);
      });
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = draft.trim();
    if (tag === "" || tags?.includes(tag)) return;
    if (await write("add_tag", tag)) {
      setDraft("");
      setToast({ id: ++toastSeq, message: `Added tag “${tag}”.`, actionLabel: "Undo", onAction: () => { void write("remove_tag", tag); } });
    }
  };

  const remove = async (tag: string) => {
    if (await write("remove_tag", tag)) {
      setToast({ id: ++toastSeq, message: `Removed tag “${tag}”.`, actionLabel: "Undo", onAction: () => { void write("add_tag", tag); } });
    }
  };

  if (tags === null) {
    return <Section state={state}>{() => null}</Section>;
  }
  return (
    <>
      {tags.length === 0 ? <div className="empty-note">No tags.</div> : (
        <ul className="tags">
          {tags.map((t) => (
            <li key={t} className="tag">
              <span>{t}</span>
              <button className="tag-x" aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => remove(t)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form className="tag-add" onSubmit={add}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a tag" aria-label="New tag" maxLength={100} disabled={busy} />
        <button className="btn btn-secondary btn-sm" type="submit" disabled={busy || draft.trim() === ""}>Add</button>
      </form>
      {error && <div className="error-text small">{error}</div>}
      <Toast toast={toast} onClose={closeToast} />
    </>
  );
}
