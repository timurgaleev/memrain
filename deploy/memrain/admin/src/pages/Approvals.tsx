import { useState } from "react";
import { automationApi } from "../api-automation.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo } from "../lib/format.ts";
import { decisionMessage, rowDecisionMessage, rowHoldText, type WriteGateHold, type WriteGateRowHold } from "../lib/automation.ts";

type Flash = { ok: boolean; message: string };
const VIEWS = ["open", "all"] as const;

const DECIDED: Record<NonNullable<WriteGateHold["decision"]>, string> = {
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Replaced by a newer version",
};

const KIND_LABEL: Record<WriteGateRowHold["kind"], string> = { fact: "fact", take: "take", timeline: "timeline entry" };

export function ApprovalsPage() {
  const [view, setView] = useState<(typeof VIEWS)[number]>("open");
  const holds = useAsync<{ holds: WriteGateHold[] }>(() => automationApi.holds(view), [view], { intervalMs: 60_000 });
  const now = useNow(30_000);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useAsync<{ holds: WriteGateRowHold[] }>(
    () => automationApi.rowHolds(view === "open" ? "held" : "all"), [view], { intervalMs: 60_000 });
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  const decideRow = async (hold: WriteGateRowHold, decision: "release" | "drop") => {
    setRowBusy(hold.id);
    try {
      const status = await automationApi.decideRowHold(hold.id, decision);
      setFlash({ ok: status === "released" || status === "dropped", message: rowDecisionMessage(status) });
    } catch (e) {
      setFlash({ ok: false, message: describeError(e) });
    } finally {
      setRowBusy(null);
      rows.reload();
    }
  };

  const decide = async (hold: WriteGateHold, decision: "approve" | "reject") => {
    setBusy(hold.id);
    try {
      const status = await automationApi.decideHold(hold.id, decision);
      setFlash({ ok: status === "approved" || status === "rejected", message: decisionMessage(status) });
    } catch (e) {
      setFlash({ ok: false, message: describeError(e) });
    } finally {
      setBusy(null);
      holds.reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Approvals</h1>
          <PageIntro>
            Outside text the write gate held because it reads like instructions to an agent. A held document is stored but
            kept out of search. Approving releases it, still marked as outside text; rejecting keeps it hidden.
          </PageIntro>
        </div>
        <div className="segmented holds-filter" role="group" aria-label="Which holds">
          {VIEWS.map((v) => (
            <button key={v} className={v === view ? "active" : ""} aria-pressed={v === view} onClick={() => setView(v)}>
              {v === "open" ? "Waiting" : "All"}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className={flash.ok ? "notice" : "warning-bar"} role={flash.ok ? "status" : "alert"}>
          {flash.message}
          <button className="btn-link flash-dismiss" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}

      <section className="panel">
        <Section
          state={holds}
          isEmpty={(d) => d.holds.length === 0}
          emptyText={view === "open"
            ? "Nothing is waiting. Held documents appear here when outside text looks like instructions."
            : "The write gate has not held anything yet."}
        >
          {(d) => (
            <ul className="hold-list">
              {d.holds.map((h) => (
                <li key={h.id} className="hold-row">
                  <div className="hold-head">
                    <span className="mono hold-target">{h.target_ref}</span>
                    <span className={`badge ${h.origin === "external" ? "badge-write" : "badge-read"}`}>
                      {h.origin === "external" ? "outside text" : "agent write"}
                    </span>
                    {h.families.map((f) => <span key={f} className="chip chip-warning">{f.replace(/_/g, " ")}</span>)}
                    <span className="muted small">{fmtAgo(h.created_at, now)} · source <span className="mono">{h.source_id}</span></span>
                  </div>
                  {/* Outside text: rendered as a text node, never as markup. */}
                  <blockquote className="hold-excerpt">{h.excerpt}</blockquote>
                  {h.decision === null && h.current ? (
                    <div className="hold-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy !== null}
                        aria-label={`Approve ${h.target_ref}`}
                        onClick={() => decide(h, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy !== null}
                        aria-label={`Reject ${h.target_ref}`}
                        onClick={() => decide(h, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <div className="muted small">
                      {h.decision ? DECIDED[h.decision] : "The document changed since it was held"}
                      {h.decided_by ? ` by ${h.decided_by}` : ""}
                      {h.decided_at ? `, ${fmtAgo(h.decided_at, now)}` : ""}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </section>

      <section className="panel">
        <h2 className="panel-title">Held facts, takes and timeline entries</h2>
        <Section
          state={rows}
          isEmpty={(d) => d.holds.length === 0}
          emptyText={view === "open"
            ? "No fact, take or timeline entry is waiting. With the row gate in quarantine mode, entries an agent or an outside source wrote that look like instructions appear here."
            : "The write gate has not held any fact, take or timeline entry yet."}
        >
          {(d) => (
            <ul className="hold-list">
              {d.holds.map((h) => {
                const { text, detail } = rowHoldText(h);
                return (
                  <li key={h.id} className="hold-row">
                    <div className="hold-head">
                      <span className="mono hold-target">{h.slug || KIND_LABEL[h.kind]}</span>
                      <span className="chip">{KIND_LABEL[h.kind]}</span>
                      <span className={`badge ${h.origin === "external" ? "badge-write" : "badge-read"}`}>
                        {h.origin === "external" ? "outside text" : "agent write"}
                      </span>
                      {h.families.map((f) => <span key={f} className="chip chip-warning">{f.replace(/_/g, " ")}</span>)}
                      <span className="muted small">{fmtAgo(h.created_at, now)} · source <span className="mono">{h.source_id}</span></span>
                    </div>
                    {/* Untrusted text: rendered as text nodes, never as markup. */}
                    <blockquote className="hold-excerpt">{text}</blockquote>
                    {detail && <blockquote className="hold-excerpt">{detail}</blockquote>}
                    {h.status === "held" ? (
                      <div className="hold-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={rowBusy !== null}
                          aria-label={`Release held ${KIND_LABEL[h.kind]} ${h.id}`}
                          onClick={() => decideRow(h, "release")}
                        >
                          Release
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={rowBusy !== null}
                          aria-label={`Drop held ${KIND_LABEL[h.kind]} ${h.id}`}
                          onClick={() => decideRow(h, "drop")}
                        >
                          Drop
                        </button>
                      </div>
                    ) : (
                      <div className="muted small">
                        {h.status === "released" ? "Released" : "Dropped"}
                        {h.decided_by ? ` by ${h.decided_by}` : ""}
                        {h.decided_at ? `, ${fmtAgo(h.decided_at, now)}` : ""}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </section>
    </>
  );
}
