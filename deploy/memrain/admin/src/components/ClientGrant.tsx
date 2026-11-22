import { useEffect, useState } from "react";
import { ApiError, grantApi } from "../api";
import { withReauth } from "../lib/passkey-ceremony.ts";
import { Dialog } from "./Dialog.tsx";

// Grant editor for one OAuth client: edit, preview the server's plan, then
// apply exactly that plan. The server recomputes the plan from the same
// partial change, so the preview and the apply cannot drift apart unnoticed.

export interface ClientGrant {
  client_id: string;
  client_name: string;
  profile: string | null;
  revision: number;
  source_id: string | null;
  federated_read: string[];
  bound_slug_prefixes: string[] | null;
  tenant_mode: string;
  scopes: string[];
  tool_surface: string;
  budget_usd_per_day: number | null;
  min_trust: string | null;
}
export interface GrantSource { id: string; name: string; federated: boolean }
interface GrantPreview {
  revision: number;
  plan_hash: string;
  before: ClientGrant;
  after: ClientGrant;
  changed: (keyof ClientGrant)[];
  widens: string[];
  revoked_unbound: { access_tokens: number; refresh_tokens: number; codes: number };
}
interface GrantDraft {
  source: string;
  reads: string[];
  prefixes: string;
  scopes: string[];
  surface: string;
  budget: string;
  floor: string;
}

const SCOPES = ["read", "write", "admin"];
const SURFACES = ["full", "starter", "verbs"];
const FLOORS = ["", "owner", "member", "agent", "external"];
const split = (text: string) => text.split(/[\s,]+/).filter(Boolean);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function grantDraft(g: ClientGrant): GrantDraft {
  return {
    source: g.source_id ?? "default",
    reads: g.federated_read,
    prefixes: (g.bound_slug_prefixes ?? []).join("\n"),
    scopes: g.scopes,
    surface: g.tool_surface,
    budget: g.budget_usd_per_day === null ? "unlimited" : String(g.budget_usd_per_day),
    floor: g.min_trust ?? "",
  };
}

/** The fields the draft changes, and only those: omitted means unchanged on the server. */
export function grantChange(g: ClientGrant, d: GrantDraft): Record<string, unknown> | string {
  const change: Record<string, unknown> = {};
  if (d.source !== (g.source_id ?? "default")) change.source = d.source;
  // A source change without a read set would reset reads to the new source.
  if (change.source !== undefined || !sameSet(d.reads, g.federated_read)) {
    if (d.reads.length === 0) return "Pick at least one readable source.";
    change.read = d.reads;
  }
  const prefixes = split(d.prefixes);
  if (!sameSet(prefixes, g.bound_slug_prefixes ?? [])) change.bound_slug_prefixes = prefixes.length > 0 ? prefixes : null;
  if (!sameSet(d.scopes, g.scopes)) {
    if (d.scopes.length === 0) return "Keep at least one scope.";
    change.scopes = d.scopes;
  }
  if (d.surface !== g.tool_surface) change.tool_surface = d.surface;
  const budgetText = d.budget.trim().toLowerCase();
  const budget = budgetText === "" || budgetText === "unlimited" ? null : Number(budgetText);
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) return "Daily budget is an amount such as 2.50, or unlimited.";
  if (budget !== g.budget_usd_per_day) change.budget_usd_per_day = budget;
  const floor = d.floor === "" ? null : d.floor;
  if (floor !== g.min_trust) change.min_trust = floor;
  return change;
}

const LABELS: [keyof ClientGrant, string][] = [
  ["source_id", "Write source"],
  ["federated_read", "Readable sources"],
  ["bound_slug_prefixes", "Write fence"],
  ["tenant_mode", "Tenant mode"],
  ["scopes", "Scopes"],
  ["tool_surface", "Tool surface"],
  ["budget_usd_per_day", "Daily budget (USD)"],
  ["min_trust", "Trust floor"],
];

function show(key: keyof ClientGrant, value: unknown): string {
  if (value === null) {
    if (key === "budget_usd_per_day") return "unlimited";
    if (key === "bound_slug_prefixes") return "whole source";
    return "none";
  }
  if (Array.isArray(value)) return value.join(", ") || "(none)";
  return String(value);
}

function implications(p: GrantPreview): string[] {
  const out: string[] = [];
  const u = p.revoked_unbound;
  if (u.access_tokens + u.refresh_tokens + u.codes > 0) {
    out.push(`Deletes ${u.access_tokens} access token(s), ${u.refresh_tokens} refresh token(s) and ${u.codes} code(s) not bound to an enrollment, because the write source or tenant mode moves.`);
  }
  if (p.changed.includes("scopes")) {
    out.push(p.widens.includes("scopes")
      ? "Added scopes reach only tokens issued after the change; removed scopes leave issued tokens at their next request."
      : "Removed scopes leave issued tokens at their next request.");
  }
  if (p.changed.some((f) => f === "tool_surface" || f === "min_trust")) {
    out.push("Tool surface and trust floor apply to every token at its next request.");
  }
  if (p.changed.includes("budget_usd_per_day")) {
    out.push(p.after.tenant_mode === "enrollment"
      ? "The daily budget applies at the next paid call; a person enrolled with a budget of their own keeps that one."
      : "The daily budget applies at the next paid call.");
  }
  if (p.changed.some((f) => f === "source_id" || f === "federated_read" || f === "bound_slug_prefixes")) {
    out.push(p.after.tenant_mode === "enrollment"
      ? "Sources and the write fence apply to the client's own tokens at their next request; tokens issued from an enrollment keep their enrollment's sources."
      : "Sources and the write fence apply to issued tokens at their next request.");
  }
  return out;
}

export function ClientGrantEditor({ clientId, onClose, onSaved }: { clientId: string; onClose: () => void; onSaved: () => void }) {
  const [grant, setGrant] = useState<ClientGrant>();
  const [sources, setSources] = useState<GrantSource[]>([]);
  const [draft, setDraft] = useState<GrantDraft>();
  const [preview, setPreview] = useState<GrantPreview>();
  const [error, setError] = useState("");
  const [stale, setStale] = useState<ClientGrant>();
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const reload = async () => {
    setBusy(true);
    try {
      const r = await grantApi.clientGrant(clientId);
      setGrant(r.grant);
      setSources(r.sources);
      setDraft(grantDraft(r.grant));
      setPreview(undefined);
      setStale(undefined);
      setNeedsReload(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void reload(); }, [clientId]);

  const edit = (next: GrantDraft) => {
    setDraft(next);
    setPreview(undefined);
    setSaved(false);
  };

  const runPreview = async () => {
    if (!grant || !draft) return;
    const change = grantChange(grant, draft);
    if (typeof change === "string") return setError(change);
    setBusy(true);
    setError("");
    try {
      setPreview(await grantApi.preview<GrantPreview>({ client_id: clientId, ...change, expected_revision: grant.revision, dry_run: true }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "grant_conflict" && e.body.current) {
        setStale(e.body.current as ClientGrant);
        setError("This grant changed since the editor opened.");
      } else {
        setError(e instanceof ApiError ? describe(e) : e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  // Rebase the owner's edits on the grant that is current now.
  const keepEdits = () => {
    if (!stale) return;
    setGrant(stale);
    setStale(undefined);
    setError("");
  };

  const apply = async () => {
    if (!grant || !draft || !preview) return;
    const change = grantChange(grant, draft);
    if (typeof change === "string") return setError(change);
    setBusy(true);
    setError("");
    try {
      await withReauth(() => grantApi.apply({ client_id: clientId, ...change, expected_revision: preview.revision, plan_hash: preview.plan_hash }));
      onSaved();
      await reload();
      setSaved(true);
    } catch (e) {
      setPreview(undefined);
      if (e instanceof ApiError && e.status === 409) {
        setNeedsReload(true);
        setError("The grant changed since the preview. Reload the current grant and review again.");
      } else if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) {
        // The request may have reached the server before the connection dropped.
        setNeedsReload(true);
        setError("The change may have completed. Reload the current grant before editing again.");
      } else {
        setError(e instanceof ApiError ? describe(e) : e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const available = new Set(sources.map((s) => s.id));
  const field = { marginBottom: 12 };
  return (
    <Dialog title={`Permissions: ${grant?.client_name ?? clientId}`} onClose={onClose} wide>
      {grant && (
        <p style={{ fontSize: 12, marginTop: 0 }}>
          Revision {grant.revision}.{grant.profile ? ` Issued from the ${grant.profile} profile, a preset that does not limit these fields.` : ""}
        </p>
      )}
      <fieldset disabled={busy || needsReload || !draft} style={{ border: 0, padding: 0, margin: 0 }}>
        {draft && (
          <>
            <div style={field}>
              <label htmlFor="grant-source">Write source</label>
              <select id="grant-source" value={draft.source} onChange={(e) => edit({ ...draft, source: e.target.value })}>
                {!available.has(draft.source) && <option value={draft.source}>{draft.source} (unavailable)</option>}
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name === s.id ? s.id : `${s.name} (${s.id})`}</option>)}
              </select>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend>Readable sources</legend>
              {[...sources, ...draft.reads.filter((id) => !available.has(id)).map((id) => ({ id, name: `${id} (unavailable)`, federated: false }))].map((s) => (
                <label className="checkbox-label" key={s.id}>
                  <input
                    type="checkbox"
                    checked={draft.reads.includes(s.id)}
                    onChange={(e) => edit({ ...draft, reads: e.target.checked ? [...draft.reads, s.id] : draft.reads.filter((id) => id !== s.id) })}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <div style={field}>
              <label htmlFor="grant-fence">Write fence: slug prefixes, one per line (empty = whole write source)</label>
              <textarea id="grant-fence" rows={2} value={draft.prefixes} onChange={(e) => edit({ ...draft, prefixes: e.target.value })} placeholder="projects/acme" />
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend>Scopes</legend>
              {SCOPES.map((s) => (
                <label className="checkbox-label" key={s}>
                  <input
                    type="checkbox"
                    checked={draft.scopes.includes(s)}
                    onChange={(e) => edit({ ...draft, scopes: e.target.checked ? [...draft.scopes, s] : draft.scopes.filter((x) => x !== s) })}
                  />
                  {s}
                </label>
              ))}
            </fieldset>
            <div style={field}>
              <label htmlFor="grant-surface">Tool surface</label>
              <select id="grant-surface" value={draft.surface} onChange={(e) => edit({ ...draft, surface: e.target.value })}>
                {SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <p style={{ fontSize: 12 }}>Which tools the agent is shown. A narrower surface hides tools; full grants no authority beyond the scopes.</p>
            </div>
            <div style={field}>
              <label htmlFor="grant-budget">Daily budget (USD)</label>
              <input id="grant-budget" value={draft.budget} onChange={(e) => edit({ ...draft, budget: e.target.value })} placeholder="unlimited" />
            </div>
            <div style={field}>
              <label htmlFor="grant-floor">Trust floor (least trusted content it may read)</label>
              <select id="grant-floor" value={draft.floor} onChange={(e) => edit({ ...draft, floor: e.target.value })}>
                {FLOORS.map((f) => <option key={f} value={f}>{f === "" ? "none" : f}</option>)}
              </select>
            </div>
          </>
        )}
      </fieldset>

      {error && (
        <p role="alert" style={{ color: "var(--error-text)", fontSize: 13 }}>
          {error}{" "}
          {stale && <button type="button" className="btn btn-secondary" onClick={keepEdits}>Refresh and keep my edits</button>}
          {needsReload && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reload()}>Reload current grant</button>}
        </p>
      )}

      {preview && (
        <div aria-live="polite">
          <h3 style={{ fontSize: 14 }}>Review changes</h3>
          {preview.changed.length === 0 ? (
            <p style={{ fontSize: 13 }}>Nothing changes. Applying still records the attempt.</p>
          ) : (
            <table>
              <thead><tr><th>Permission</th><th>Current</th><th>Proposed</th></tr></thead>
              <tbody>
                {LABELS.filter(([key]) => preview.changed.includes(key)).map(([key, label]) => (
                  <tr key={key}>
                    <th>{label}</th>
                    <td className="mono" style={{ overflowWrap: "anywhere" }}>{show(key, preview.before[key])}</td>
                    <td className="mono" style={{ overflowWrap: "anywhere" }}>{show(key, preview.after[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {implications(preview).map((line) => <p key={line} style={{ fontSize: 12 }}>{line}</p>)}
          {preview.widens.length > 0 && (
            <p style={{ fontSize: 12, color: "var(--warning)" }}>
              Widens {preview.widens.map((f) => LABELS.find(([k]) => k === f)?.[1] ?? f).join(", ")}: applying needs passkey confirmation.
            </p>
          )}
        </div>
      )}

      {saved && <p role="status" style={{ fontSize: 13 }}>Permissions saved.</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || needsReload || !draft}
          onClick={() => void (preview ? apply() : runPreview())}
        >
          {busy ? "Checking..." : preview ? "Apply reviewed changes" : "Preview changes"}
        </button>
      </div>
    </Dialog>
  );
}

function describe(e: ApiError): string {
  if (e.code === "invalid_grant" && Array.isArray(e.body.reasons)) {
    return (e.body.reasons as { detail?: string }[]).map((r) => r.detail ?? "").filter(Boolean).join("; ");
  }
  if (e.code === "reauth_required") return "This change widens the grant and needs passkey confirmation.";
  return e.code;
}
