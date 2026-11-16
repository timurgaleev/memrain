import { useRef, useState } from "react";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo } from "../lib/format.ts";
import { latestOnly, parseTagInput } from "../lib/labels.ts";
import type { EvalCandidate, EvalCandidateList, EvalPreview } from "../admin-types.ts";

type Split = "auto" | "dev" | "sealed";

export function LabellingPage() {
  const list = useAsync<EvalCandidateList>((signal) => api.evalCandidates(signal), []);
  const [open, setOpen] = useState<EvalCandidate | null>(null);
  const [preview, setPreview] = useState<EvalPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tagText, setTagText] = useState("");
  const [lang, setLang] = useState("en");
  const [split, setSplit] = useState<Split>("auto");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A preview that returns after another query was opened (or the panel was
  // closed) belongs to that other query; showing it would let its documents be
  // saved as this query's labels.
  const previews = useRef(latestOnly());
  // True while the query opened last is still the open one; a save or dismiss
  // that finishes later must not close a query opened in the meantime.
  const stillOpen = useRef<() => boolean>(() => false);
  const now = Date.now();

  const close = () => {
    previews.current.start();
    setOpen(null);
  };

  const review = async (c: EvalCandidate) => {
    setError("");
    setOpen(c);
    setPreview(null);
    setPicked(new Set());
    const current = previews.current.start();
    stillOpen.current = current;
    try {
      const p = await api.evalPreview({ candidate_id: c.id });
      if (current()) setPreview(p);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "Could not load the preview.");
    }
  };

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const save = async () => {
    if (!open) return;
    const { tags, error: tagError } = parseTagInput(tagText);
    if (tagError) return setError(tagError);
    if (picked.size === 0) return setError("Mark at least one document that answers the query.");
    setBusy(true);
    setError("");
    const same = stillOpen.current;
    try {
      await api.evalLabel({
        candidate_id: open.id,
        expected_doc_ids: [...picked],
        tags,
        lang,
        ...(split === "auto" ? {} : { split }),
      });
      if (same()) close();
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the label.");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (c: EvalCandidate) => {
    setError("");
    const same = open?.id === c.id ? stillOpen.current : () => false;
    try {
      await api.evalDismiss(c.id);
      if (same()) close();
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not dismiss.");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Labelling</h1>
          <PageIntro>
            Turn real queries into the live eval set. Open a captured query, mark every document that answers it, add tags
            such as intent:topic or kind:alias, and save. Labels feed memrain eval promote --live. Leave the split on auto so
            three in ten go to the sealed set by a hash of the query.
          </PageIntro>
        </div>
      </div>

      {error && <div className="tile-error tile-error-inline"><span>{error}</span></div>}

      <Section state={list}>
        {(r) => (
          <>
            <div className="empty-note">
              Labelled: {r.labels.dev} dev, {r.labels.sealed} sealed, of a target of {r.labels.target}.{" "}
              {r.capture.enabled
                ? r.capture.scrub ? "Capture is on; queries are scrubbed of personal data before they are stored." : "Capture is on without scrubbing."
                : "Capture is off: set evalCapture.enabled in memrain.yml and restart the server to collect queries."}
            </div>
            {open && (
              <div className="tile">
                <div className="mono">{open.query}</div>
                {preview === null ? (
                  <div className="empty-note">Searching…</div>
                ) : preview.results.length === 0 ? (
                  <div className="empty-note">The search returned nothing for this query.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Answers it</th><th>Document</th><th>Excerpt</th></tr></thead>
                      <tbody>
                        {preview.results.map((d) => (
                          <tr key={d.document_id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`relevant: ${d.title ?? d.source_path}`}
                                checked={picked.has(d.document_id)}
                                onChange={() => toggle(d.document_id)}
                              />
                            </td>
                            <td>{d.title ?? d.source_path}<div className="muted mono">{d.source_path}</div></td>
                            <td className="muted">{d.snippet}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <label>Tags <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="intent:topic kind:alias" /></label>{" "}
                <label>Language <input value={lang} onChange={(e) => setLang(e.target.value.trim().toLowerCase())} size={3} maxLength={2} /></label>{" "}
                <label>
                  Split{" "}
                  <select value={split} onChange={(e) => setSplit(e.target.value as Split)}>
                    <option value="auto">auto</option>
                    <option value="dev">dev</option>
                    <option value="sealed">sealed</option>
                  </select>
                </label>{" "}
                <button className="btn btn-sm" disabled={busy} onClick={save}>Save label</button>{" "}
                <button className="btn btn-secondary btn-sm" onClick={close}>Close</button>
              </div>
            )}
            {r.candidates.length === 0 ? (
              <div className="empty-note">No captured queries waiting.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Query</th><th>From</th><th>Captured</th><th /></tr></thead>
                  <tbody>
                    {r.candidates.map((c) => (
                      <tr key={c.id} className={open?.id === c.id ? "active" : undefined}>
                        <td className="mono">{c.query}{!c.scrubbed && <div className="muted">not scrubbed</div>}</td>
                        <td className="mono">{c.tool_name}</td>
                        <td>{fmtAgo(c.captured_at, now)}</td>
                        <td>
                          <button className="btn-link" onClick={() => review(c)}>Review</button>{" "}
                          <button className="btn-link" onClick={() => dismiss(c)}>Dismiss</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Section>
    </>
  );
}
