import { useState, useEffect } from "react";
import { api } from "../api";
import { ClientMembers } from "./ClientMembers";
import { copyText } from "../lib/clipboard.ts";

// Credentials section of the Agents page: the unified view over OAuth
// clients + legacy API keys (personal access tokens), with per-credential
// usage, PAT mint/revoke, OAuth client register/revoke, and the per-client
// token TTL override. Minted secrets are shown ONCE — only hashes persist.

interface CredentialUsage {
  requests_today: number;
  total_requests: number;
  last_used_at: string | null;
}

interface CredentialRow {
  auth_type: "oauth" | "api_key";
  id: string;
  name: string;
  grant_types: string[] | null;
  scope: string | null;
  token_ttl: number | null;
  source_id: string | null;
  federated_read: string[] | null;
  redirect_uris: string[] | null;
  tenant_mode: string | null;
  grant_revision: number | null;
  status: string;
  created_at: string;
  usage: CredentialUsage;
}

export function CredentialsSection({ setError }: { setError: (s: string) => void }) {
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [modal, setModal] = useState<null | "api-key" | "client">(null);
  const [members, setMembers] = useState<CredentialRow | null>(null);

  const load = () =>
    api.agents()
      .then((r: { agents: CredentialRow[] }) => setRows(r.agents))
      .catch((e) => setError(String((e as Error).message ?? e)));

  useEffect(() => { load(); }, []);

  const revoke = async (row: CredentialRow) => {
    const what = row.auth_type === "oauth" ? "OAuth client (and all its live tokens)" : "API key";
    if (!confirm(`Revoke ${what} "${row.name}"?`)) return;
    try {
      if (row.auth_type === "oauth") await api.revokeClient(row.id);
      else await api.revokeApiKey(row.name);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const setTtl = async (row: CredentialRow) => {
    const raw = prompt(
      `Token TTL in seconds for "${row.name}" (empty or 0 = server default):`,
      row.token_ttl != null ? String(row.token_ttl) : "",
    );
    if (raw === null) return;
    const trimmed = raw.trim();
    try {
      await api.updateClientTtl(row.id, trimmed === "" || trimmed === "0" ? null : Number(trimmed));
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const rescope = async (row: CredentialRow) => {
    const source = prompt(
      `Write source id for "${row.name}":`,
      row.source_id ?? "default",
    );
    if (source === null || source.trim() === "") return;
    const readRaw = prompt(
      "Federated read ids (comma-separated; empty = write source only):",
      (row.federated_read ?? []).join(", "),
    );
    if (readRaw === null) return;
    const readIds = readRaw.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await api.rescopeClient(row.id, source.trim(), readIds.length > 0 ? readIds : undefined);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const setRedirects = async (row: CredentialRow) => {
    const raw = prompt(
      `Redirect URIs for "${row.name}" (comma-separated; https, or http on localhost). The secret is kept.`,
      (row.redirect_uris ?? []).join(", "),
    );
    if (raw === null) return;
    const uris = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (uris.length === 0) return;
    try {
      await api.setRedirectUris(row.id, uris, row.grant_revision ?? undefined);
      await load();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(msg === "grant_conflict" ? `"${row.name}" changed since this page loaded; reload and try again.` : msg);
    }
  };

  return (
    <>
      <h2 className="page-title" style={{ fontSize: 18, marginTop: 28 }}>Credentials</h2>
      <div className="filter-bar">
        <button className="btn btn-primary" onClick={() => setModal("client")}>Register OAuth client</button>
        <button className="btn btn-secondary" onClick={() => setModal("api-key")}>Mint API key</button>
      </div>

      {rows.length === 0 ? (
        <div className="feed-empty">No credentials yet. Register an OAuth client or mint an API key.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Status</th><th>Scope</th><th>TTL</th>
              <th>Today</th><th>Total</th><th>Last used</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.auth_type}:${r.id}`}>
                <td className="mono" title={r.id}>{r.name}</td>
                <td><span className={r.auth_type === "oauth" ? "badge badge-write" : "badge badge-read"}>{r.auth_type}</span></td>
                <td>{r.status}</td>
                <td className="mono">{r.scope ?? (r.auth_type === "api_key" ? "read write" : "")}</td>
                <td>{r.auth_type === "oauth" ? (r.token_ttl != null ? `${r.token_ttl}s` : "default") : "—"}</td>
                <td>{r.usage.requests_today}</td>
                <td>{r.usage.total_requests}</td>
                <td>{r.usage.last_used_at ? r.usage.last_used_at.slice(0, 19) : "never"}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {r.auth_type === "oauth" && r.status === "active" && (
                    <>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: 12, marginRight: 6 }}
                        title={`source: ${r.source_id ?? "default"} · read: ${(r.federated_read ?? []).join(", ") || "—"}`}
                        onClick={() => rescope(r)}
                      >
                        Scope
                      </button>
                      <button className="btn btn-secondary" style={{ fontSize: 12, marginRight: 6 }} onClick={() => setTtl(r)}>TTL</button>
                      {(r.grant_types ?? []).includes("authorization_code") && (
                        <>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 12, marginRight: 6 }}
                            title={(r.redirect_uris ?? []).join("\n") || "no redirect URIs"}
                            onClick={() => setRedirects(r)}
                          >
                            Redirects
                          </button>
                          <button className="btn btn-secondary" style={{ fontSize: 12, marginRight: 6 }} onClick={() => setMembers(r)}>
                            Members
                          </button>
                        </>
                      )}
                    </>
                  )}
                  {r.status === "active" && (
                    <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={() => revoke(r)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal === "api-key" && <MintApiKeyModal onClose={() => setModal(null)} onDone={load} setError={setError} />}
      {modal === "client" && <RegisterClientModal onClose={() => setModal(null)} onDone={load} setError={setError} />}
      {members && (
        <ClientMembers
          clientId={members.id}
          clientName={members.name}
          tenantMode={members.tenant_mode}
          onClose={() => setMembers(null)}
          setError={setError}
        />
      )}
    </>
  );
}

// One-time secret block: the only place the plaintext ever appears.
function SecretOnce({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // A blocked clipboard leaves the text on screen to select by hand.
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <label>{label}</label>
        <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="mono" style={{ margin: 0, padding: 8, overflowX: "auto", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {value}
      </pre>
    </div>
  );
}

function MintApiKeyModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const r = (await api.mintApiKey(name.trim())) as { name: string; token: string };
      setMinted(r);
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Mint API key</div>
        {minted ? (
          <>
            <div style={{ marginBottom: 8, fontSize: 13 }}>
              Store the token now — only its hash persists.
            </div>
            <SecretOnce label={`Token — ${minted.name}`} value={minted.token} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <label>Key name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || name.trim() === ""} onClick={submit}>
                {busy ? "Minting..." : "Mint"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RegisterClientModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("read");
  const [redirectUris, setRedirectUris] = useState("");
  const [ttl, setTtl] = useState("");
  const [source, setSource] = useState("");
  const [read, setRead] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ client_id: string; client_secret: string | null } | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const uris = redirectUris.split(",").map((s) => s.trim()).filter(Boolean);
      const readIds = read.split(",").map((s) => s.trim()).filter(Boolean);
      const payload: Record<string, unknown> = { name: name.trim(), scopes: scopes.trim() };
      if (uris.length > 0) payload.redirect_uris = uris;
      if (ttl.trim() !== "") payload.token_ttl = Number(ttl.trim());
      if (source.trim() !== "") payload.source = source.trim();
      if (readIds.length > 0) payload.read = readIds;
      const r = (await api.registerClient(payload)) as { client_id: string; client_secret: string | null };
      setResult(r);
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Register OAuth client</div>
        {result ? (
          <>
            <div style={{ marginBottom: 8, fontSize: 13 }}>
              {result.client_secret
                ? "Store the client secret now — it is not recoverable."
                : "Public client — no secret minted; PKCE authenticates."}
            </div>
            <SecretOnce label="Client ID" value={result.client_id} />
            {result.client_secret && <SecretOnce label="Client secret" value={result.client_secret} />}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <label>Client name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-web" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>Scopes (space-separated)</label>
              <input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="read write" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>Redirect URIs (comma-separated — makes it a browser client)</label>
              <input value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} placeholder="https://example.com/callback" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>Token TTL seconds (optional — empty = server default)</label>
              <input value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="3600" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>Write source id (optional — default tenant when empty)</label>
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="acme" />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label>Federated read ids (comma-separated, optional)</label>
              <input value={read} onChange={(e) => setRead(e.target.value)} placeholder="acme, shared" />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || name.trim() === ""} onClick={submit}>
                {busy ? "Registering..." : "Register"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
