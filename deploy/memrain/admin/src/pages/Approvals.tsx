import { useState } from "react";
import { automationApi } from "../api-automation.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo } from "../lib/format.ts";
import {
  decisionMessage, rowDecisionMessage, rowHoldText, trustDecisionMessage,
  type TrustProposal, type WriteGateHold, type WriteGateRowHold,
} from "../lib/automation.ts";

type Flash = { ok: boolean; message: string };
const VIEWS = ["open", "all"] as const;

const DECIDED: Record<NonNullable<WriteGateHold["decision"]>, string> = {
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Replaced by a newer version",
};

const KIND_LABEL: Record<WriteGateRowHold["kind"], string> = { fact: "fact", take: "take", timeline: "timeline entry" };

const TRUST_DECIDED: Record<Exclude<TrustProposal["status"], "pending">, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  stale: "Out of date: a fact changed since",
};

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

  const proposals = useAsync<{ proposals: TrustProposal[] }>(
    () => automationApi.trustProposals(view === "open" ? "pending" : "all"), [view], { intervalMs: 60_000 });
  const [proposalBusy, setProposalBusy] = useState<number | null>(null);

  const decideProposal = async (p: TrustProposal, decision: "accept" | "reject") => {
    setProposalBusy(p.id);
    try {
      const status = await automationApi.decideTrustProposal(p.id, decision);
      setFlash({ ok: status === "accepted" || status === "rejected", message: trustDecisionMessage(status) });
    } catch (e) {
      setFlash({ ok: false, message: describeError(e) });
    } finally {
      setProposalBusy(null);
      proposals.reload();
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

      <section className="panel">
        <h2 className="panel-title">Trust proposals</h2>
        <Section
          state={proposals}
          isEmpty={(d) => d.proposals.length === 0}
          emptyText={view === "open"
            ? "No trust proposal is waiting. When an agent or an outside source would replace a fact you or a more trusted writer recorded, the old fact stays and the change waits here."
            : "No write has tried to replace a more trusted fact yet."}
        >
          {(d) => (
            <ul className="hold-list">
              {d.proposals.map((p) => (
                <li key={p.id} className="hold-row">
                  <div className="hold-head">
                    <span className="mono hold-target">{p.entity_slug ?? `fact ${p.target_id}`}{p.dimension ? ` · ${p.dimension}` : ""}</span>
                    <span className="chip">{p.old_tier} → {p.new_tier}</span>
                    <span className="muted small">{fmtAgo(p.created_at, now)} · source <span className="mono">{p.source_id}</span></span>
                  </div>
                  {/* Fact text may be outside text: rendered as text nodes, never as markup. */}
                  <div className="muted small">Current ({p.old_tier})</div>
                  <blockquote className="hold-excerpt">{p.old_fact ?? ""}</blockquote>
                  {p.action === "forget" ? (
                    <div className="muted small">An {p.new_tier} credential asked to forget it. Accept forgets it; reject keeps it.</div>
                  ) : (
                    <>
                      <div className="muted small">Proposed ({p.new_tier})</div>
                      <blockquote className="hold-excerpt">{p.new_fact ?? ""}</blockquote>
                    </>
                  )}
                  {p.status === "pending" ? (
                    <div className="hold-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={proposalBusy !== null}
                        aria-label={`Accept trust proposal ${p.id}`}
                        onClick={() => decideProposal(p, "accept")}
                      >
                        Accept
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={proposalBusy !== null}
                        aria-label={`Reject trust proposal ${p.id}`}
                        onClick={() => decideProposal(p, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <div className="muted small">
                      {TRUST_DECIDED[p.status]}
                      {p.decided_by ? ` by ${p.decided_by}` : ""}
                      {p.decided_at ? `, ${fmtAgo(p.decided_at, now)}` : ""}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </section>
    </>
  );
}
