import { useCallback, useEffect, useState } from "react";
import { ApiError, api, passkeyApi } from "../api";
import type { AuthEvent, PasskeyList, PasskeyRow } from "../api";
import { CopyField } from "../components/CopyField.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { RecoveryCodes } from "../components/RecoveryCodes.tsx";
import { eventLabel, errorCodeOf, listOf, passkeyErrorCopy } from "../lib/passkey.ts";
import { failureCode, register, withReauth } from "../lib/passkey-ceremony.ts";

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

// The cooldown refusal carries its end time; the copy names it.
function describeFailure(e: unknown): string {
  const code = failureCode(e);
  if (code === "cancelled") return "Cancelled. Nothing was changed.";
  const base = passkeyErrorCopy(code);
  if (code === "cooldown" && e instanceof ApiError && typeof e.body.until === "string") {
    return `${base} Available again ${fmtWhen(e.body.until)}.`;
  }
  return base;
}

export function SecurityPage() {
  const [data, setData] = useState<PasskeyList | null>(null);
  const [events, setEvents] = useState<AuthEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, ev] = await Promise.all([passkeyApi.passkeys(), passkeyApi.events(20)]);
      setData(list);
      setEvents(listOf<AuthEvent>(ev, "events"));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "unauthorized")) setError(describeFailure(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setError("");
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy("");
      await load();
    }
  };

  const revoke = (row: PasskeyRow) => run(`revoke:${row.id}`, async () => {
    if (!confirm(`Remove the passkey "${row.label}"? Every session signed in with it ends now.`)) return;
    try {
      await withReauth(() => passkeyApi.revoke(row.id));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "last_passkey")) throw e;
      if (!confirm(`${passkeyErrorCopy("last_passkey")} Remove it anyway?`)) return;
      await withReauth(() => passkeyApi.revoke(row.id, true));
    }
  });

  const saveRename = () => {
    if (!editing) return;
    const label = editing.label.trim();
    if (label === "") return;
    void run(`rename:${editing.id}`, async () => {
      await passkeyApi.rename(editing.id, label);
      setEditing(null);
    });
  };

  const addPasskey = () => run("add", async () => {
    const named = prompt("Name for the new passkey:", "Another device");
    if (named === null) return;
    const label = named.trim() || "Another device";
    const { optionsJSON } = await withReauth(() => passkeyApi.sessionRegisterOptions());
    const response = await register(optionsJSON);
    const r = await passkeyApi.registerVerify(response, label);
    if (!r.ok) throw new ApiError(errorCodeOf(r.status, r.body), r.status, r.body);
    if (Array.isArray(r.body.recovery_codes) && r.body.recovery_codes.length > 0) setCodes(r.body.recovery_codes);
  });

  const regenerate = () => run("codes", async () => {
    if (!confirm("Replace your recovery codes? The old codes stop working immediately.")) return;
    const r = await withReauth(() => passkeyApi.regenerateCodes());
    setCodes(r.recovery_codes);
  });

  const mintLink = () => run("link", async () => {
    setLink(await withReauth(() => passkeyApi.mintSetupLink()));
  });

  const signOutEverywhere = async () => {
    if (!confirm("Sign out every admin session, including this one, and cancel unused setup links?")) return;
    try {
      await api.signOutEverywhere();
    } catch (e) {
      if (e instanceof Error && e.message === "cooldown") {
        setError(passkeyErrorCopy("cooldown"));
        return;
      }
      // the session may already be gone
    }
    window.location.hash = "#login";
  };

  if (codes !== null) {
    return (
      <>
        <h1 className="page-title">Security</h1>
        <div className="security-card" style={{ maxWidth: 460 }}>
          <RecoveryCodes codes={codes} onContinue={() => setCodes(null)} continueLabel="Done" />
        </div>
      </>
    );
  }

  const passkeys = data?.passkeys ?? [];
  const inCooldown = data?.session_in_cooldown === true;

  return (
    <>
      <h1 className="page-title">Security</h1>
      <PageIntro>The passkeys that can sign in to this panel, your recovery codes, and recent sign-in activity.</PageIntro>

      {error && <div className="warning-bar" role="alert">{error}</div>}
      {data?.session_in_cooldown && (
        <div className="notice">
          This session's passkey was added in the last 24 hours. Until {fmtWhen(data.cooldown_until)} it cannot add or
          remove passkeys, replace recovery codes, create setup links, sign out everywhere, dismiss security notices,
          approve app connections or change API keys, OAuth apps or enrollments. An older passkey or the operator can.
        </div>
      )}
      {data?.single_device_only_warning && (
        <div className="warning-bar">
          Your only passkey lives on one device and is not backed up. If you lose that device you will need a recovery
          code. Add a passkey on a second device.
        </div>
      )}

      <div className="section-title">Passkeys</div>
      {data === null ? (
        <div className="empty-note">Loading...</div>
      ) : passkeys.length === 0 ? (
        <div className="empty-note">No passkeys yet. You are signed in with operator access.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Added</th><th>Last used</th><th></th></tr>
            </thead>
            <tbody>
              {passkeys.map((p) => (
                <tr key={p.id}>
                  <td>
                    {editing?.id === p.id ? (
                      <form className="security-rename" onSubmit={(e) => { e.preventDefault(); saveRename(); }}>
                        <input
                          aria-label="Passkey name"
                          maxLength={64}
                          autoFocus
                          value={editing.label}
                          onChange={(e) => setEditing({ id: p.id, label: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
                        />
                        <button className="btn btn-secondary btn-sm" disabled={busy !== ""}>Save</button>
                      </form>
                    ) : (
                      <button className="btn-link" title="Rename" onClick={() => setEditing({ id: p.id, label: p.label })}>
                        {p.label}
                      </button>
                    )}
                    {p.in_cooldown && <span className="badge badge-write" style={{ marginLeft: 8 }}>new</span>}
                  </td>
                  <td>{p.device_type === "multiDevice" ? "synced" : "this device only"}</td>
                  <td title={p.created_via}>{fmtWhen(p.created_at)}</td>
                  <td>{fmtWhen(p.last_used_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-danger btn-sm" onClick={() => revoke(p)} disabled={busy !== ""}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="filter-bar" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={addPasskey} disabled={busy !== "" || inCooldown}>
          {busy === "add" ? "Waiting for your device..." : "Add another passkey"}
        </button>
      </div>

      <div className="section-title">Recovery codes</div>
      <div className="filter-bar">
        <span className="small">{data ? `${data.recovery_codes_left} of 10 left` : "—"}</span>
        <button className="btn btn-secondary btn-sm" onClick={regenerate} disabled={busy !== ""}>Regenerate</button>
      </div>
      <p className="hint">A code is used up once the new passkey it unlocks is created.</p>

      <div className="section-title">Setup link for another device</div>
      <p className="hint">
        A one-time link that lets a device without a passkey create one. It works for 24 hours, and creating a new link
        cancels the previous unused one.
      </p>
      {link ? (
        <div style={{ maxWidth: 640 }}>
          <CopyField value={link.url} label="setup link" />
          <div className="hint">Expires {fmtWhen(link.expires_at)}. Send it over a private channel.</div>
        </div>
      ) : (
        <button className="btn btn-secondary" onClick={mintLink} disabled={busy !== ""}>Create setup link</button>
      )}

      <div className="section-title">Sessions</div>
      <button className="btn btn-secondary" onClick={signOutEverywhere} disabled={inCooldown}>Sign out everywhere</button>
      <p className="hint">Ends every admin session, including this one, and cancels unused setup links.</p>

      <div className="section-title">Recent sign-in activity</div>
      {events.length === 0 ? (
        <div className="empty-note">No activity recorded yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>What</th><th>Result</th><th>From</th></tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={String(ev.id)}>
                  <td className="num">{fmtWhen(ev.at)}</td>
                  <td>
                    {eventLabel(ev.event)}
                    {ev.via ? <span className="muted"> · {ev.via.replace("_", " ")}</span> : null}
                  </td>
                  <td>
                    <span className={ev.outcome === "ok" ? "badge badge-success" : "badge badge-error"}>
                      {ev.outcome === "ok" ? "ok" : (ev.reason ?? "failed")}
                    </span>
                  </td>
                  <td className="ellipsis small" title={ev.user_agent ?? undefined}>{ev.client_key ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
