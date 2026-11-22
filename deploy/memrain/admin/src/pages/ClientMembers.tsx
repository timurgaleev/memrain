import { useState, useEffect } from "react";
import { api } from "../api";
import { withReauth } from "../lib/passkey-ceremony.ts";

// The people on one connector: each enrollment code pinned to the client (or
// open to any enrollment-mode client), whether it was redeemed, whether it was
// revoked, and when a token was last minted under it. Unused codes are killed
// with revoke-enrollment; a redeemed member is cut off with revoke-grant, which
// also deletes every token issued to her. Codes are shown ONCE, at issue.

interface Member {
  id: string;
  label: string | null;
  source_id: string;
  federated_read: string[];
  client_id: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  spend_id: string;
  replaces_id: string | null;
  budget_usd_per_day: number | null;
  last_token_at: string | null;
}

interface Issued {
  enrollment_id: string;
  code: string;
  source_id: string;
  expires_at: string;
  replaces: string | null;
}

const ts = (v: string | null) => (v ? v.slice(0, 19) : "—");

function state(m: Member): string {
  if (m.revoked_at) return m.used_at ? "revoked" : "code revoked";
  if (m.used_at) return "redeemed";
  if (new Date(m.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

export function ClientMembers({
  clientId,
  clientName,
  tenantMode,
  onClose,
  setError,
}: {
  clientId: string;
  clientName: string;
  tenantMode: string | null;
  onClose: () => void;
  setError: (s: string) => void;
}) {
  const [rows, setRows] = useState<Member[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [source, setSource] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.enrollments(clientId)
      .then((r: { enrollments: Member[] }) => setRows(r.enrollments))
      .catch((e) => setError(String((e as Error).message ?? e)));

  useEffect(() => { load(); }, [clientId]);

  const issue = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      setIssued((await withReauth(() => api.issueEnrollment(payload))) as Issued);
      setSource("");
      setLabel("");
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (m: Member) => {
    const who = m.label ?? m.id;
    const what = m.used_at
      ? `Cut off "${who}"? Every token issued to them is deleted now.`
      : `Revoke the unused code for "${who}"?`;
    if (!confirm(what)) return;
    try {
      if (m.used_at) await api.revokeGrant(m.id);
      else await api.revokeEnrollment(m.id);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const replace = (m: Member) => {
    if (!confirm(`Issue a new code for "${m.label ?? m.id}"? Redeeming it revokes the current grant; spend keeps counting under the same key.`)) return;
    issue({ replaces: m.id });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Members — {clientName}</div>

        {issued && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>
              Give this code to the person — it works once and is not shown again
              {issued.replaces ? `; redeeming it revokes ${issued.replaces}` : ""}.
            </div>
            <pre className="mono code-block" style={{ margin: 0, padding: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {issued.code}
            </pre>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              source {issued.source_id} · expires {ts(issued.expires_at)}
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="feed-empty">No enrollment codes for this client yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Member</th><th>Source</th><th>State</th><th>Redeemed</th><th>Last token</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="mono" title={`${m.id}\nspend key: ${m.spend_id}${m.replaces_id ? `\nreplaces: ${m.replaces_id}` : ""}`}>
                    {m.label ?? m.id}
                  </td>
                  <td className="mono">{m.source_id}</td>
                  <td>{state(m)}</td>
                  <td>{ts(m.used_at)}</td>
                  <td>{ts(m.last_token_at)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {m.used_at && (
                      <button className="btn btn-secondary" style={{ fontSize: 12, marginRight: 6 }} disabled={busy} onClick={() => replace(m)}>
                        New code
                      </button>
                    )}
                    {!m.revoked_at && (
                      <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={() => revoke(m)}>
                        {m.used_at ? "Revoke grant" : "Revoke code"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tenantMode === "enrollment" && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <label>Source id</label>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="tina" />
          </div>
          <div style={{ flex: 1 }}>
            <label>Label (optional)</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Tina" />
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || source.trim() === ""}
            onClick={() =>
              issue({ client_id: clientId, source: source.trim(), ...(label.trim() ? { label: label.trim() } : {}) })
            }
          >
            {busy ? "Issuing..." : "Issue code"}
          </button>
        </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
