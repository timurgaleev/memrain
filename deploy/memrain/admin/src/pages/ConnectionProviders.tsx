import { useId, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { CopyField } from "../components/CopyField.tsx";
import { Dialog } from "../components/Dialog.tsx";
import {
  providerLabel,
  sourcesFor,
  type ConnectorProviderView,
  type OAuthClientView,
  type SourceView,
} from "../lib/automation.ts";
import { goToConsent } from "./connection-actions.ts";

interface Props {
  provider: ConnectorProviderView;
  sources: SourceView[];
  client: OAuthClientView | null;
  connectorsOn: boolean;
  onDone: (message: string) => void;
  onError: (e: unknown) => void;
}

/** The API-key field of a provider's panel; an account row focuses it to take a replacement key. */
export function providerKeyFieldId(provider: string): string {
  return `connect-key-${provider}`;
}

/** One provider: what to read and where to put it, then connect; plus its own-app settings. */
export function ProviderPanel({ provider: p, sources, client, connectorsOn, onDone, onError }: Props) {
  const name = providerLabel(p.id);
  const [services, setServices] = useState<string[]>(p.services);
  const fitting = sourcesFor(p.service_kinds, services, sources);
  const [sourceId, setSourceId] = useState("");
  const chosen = fitting.some((s) => s.id === sourceId) ? sourceId : fitting[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const sourceFieldId = useId();
  const kinds = [...new Set(services.flatMap((s) => p.service_kinds[s] ?? []))];

  const toggle = (svc: string, on: boolean) =>
    setServices((cur) => (on ? p.services.filter((s) => s === svc || cur.includes(s)) : cur.filter((s) => s !== svc)));

  const [key, setKey] = useState("");
  const keyField = providerKeyFieldId(p.id);
  const ready = connectorsOn && chosen !== "" && services.length > 0 && (p.auth === "oauth" || key.trim() !== "");

  const connect = async () => {
    setBusy(true);
    try {
      if (p.auth === "oauth") {
        await goToConsent(p.id, chosen, services);
        return;
      }
      await automationApi.saveApiKey(p.id, chosen, services, key.trim());
      setKey("");
      onDone(`${name} is connected. Sync stays off until you switch it on.`);
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  };

  return (
    <section className="panel provider-panel" aria-labelledby={`${sourceFieldId}-title`}>
      <div className="panel-head">
        <h3 className="panel-title" id={`${sourceFieldId}-title`}>{name}</h3>
        {client && <span className="badge badge-read">Your own app</span>}
      </div>

      <form className="connect-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        {p.services.length > 1 && (
          <fieldset className="connect-services">
            <legend>Read</legend>
            <div className="checkbox-group">
              {p.services.map((svc) => (
                <label key={svc} className="checkbox-label">
                  <input type="checkbox" checked={services.includes(svc)} onChange={(e) => toggle(svc, e.target.checked)} />
                  {svc}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="field connect-source">
          <label htmlFor={sourceFieldId}>Into source</label>
          <select id={sourceFieldId} value={chosen} disabled={fitting.length === 0} onChange={(e) => setSourceId(e.target.value)}>
            {fitting.length === 0 && <option value="">No source fits</option>}
            {fitting.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </div>
        {p.auth === "api_key" && (
          <div className="field connect-key">
            <label htmlFor={keyField}>{name} API key</label>
            <input id={keyField} type="password" value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !ready} aria-label={`Connect ${name}`}>
          {busy ? (p.auth === "oauth" ? "Opening…" : "Checking…") : `Connect ${name}`}
        </button>
      </form>
      {services.length > 0 && fitting.length === 0 && (
        <p className="hint">
          No source can hold {kinds.join(" or ")} data yet. Register one with{" "}
          <code>memrain sources register &lt;id&gt; --kind {kinds[0] ?? "calendar"} --path-prefix &lt;prefix&gt;/</code>, then reload this page.
        </p>
      )}

      {p.auth === "oauth" && <OwnAppSettings provider={p} client={client} onDone={onDone} onError={onError} />}
    </section>
  );
}

/** Bring-your-own OAuth app: the callback to register, then the app's id and secret. The secret is never shown again. */
function OwnAppSettings({ provider: p, client, onDone, onError }: {
  provider: ConnectorProviderView;
  client: OAuthClientView | null;
  onDone: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const name = providerLabel(p.id);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const idField = useId();
  const secretField = useId();

  const save = async () => {
    setBusy(true);
    try {
      await automationApi.saveClient(p.id, clientId.trim(), secret);
      setClientId("");
      setSecret("");
      onDone(`Saved your ${name} app. New connections use it.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setAskRemove(false);
    setBusy(true);
    try {
      await automationApi.deleteClient(p.id);
      onDone(`Removed your ${name} app.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="own-app">
      <summary>Use your own OAuth app</summary>
      <div className="own-app-body">
        {client && (
          <p className="dialog-text">
            Using <span className="mono">{client.client_id}</span>, saved {new Date(client.updated_at).toLocaleDateString()}.{" "}
            <button className="btn-link" disabled={busy} onClick={() => setAskRemove(true)}>Remove</button>
          </p>
        )}
        {p.callback_uri ? (
          <div className="own-app-callback">
            <span className="field-label">Register this redirect URL in the app</span>
            <CopyField value={p.callback_uri} label={`Callback URL for ${name}`} />
          </div>
        ) : (
          <p className="hint">Set <code>MEMRAIN_PUBLIC_URL</code> to the brain's https address first; the redirect URL is built from it.</p>
        )}
        <form className="own-app-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="field">
            <label htmlFor={idField}>Client ID</label>
            <input id={idField} value={clientId} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={secretField}>Client secret</label>
            <input id={secretField} type="password" value={secret} autoComplete="new-password" onChange={(e) => setSecret(e.target.value)} />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={busy || clientId.trim() === "" || secret === ""}>
            {client ? "Replace app" : "Save app"}
          </button>
        </form>
      </div>
      {askRemove && client && (
        <Dialog title={`Remove your ${name} app?`} onClose={() => setAskRemove(false)}>
          <p className="dialog-text">
            <span className="mono">{client.client_id}</span> and its secret are forgotten. New connections fall back to the
            server's app, if one is configured; connected accounts need reconnecting once their access has to be renewed.
          </p>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setAskRemove(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={remove}>Remove app</button>
          </div>
        </Dialog>
      )}
    </details>
  );
}
