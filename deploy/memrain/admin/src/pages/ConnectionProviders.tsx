import { useId, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { CopyField } from "../components/CopyField.tsx";
import { Dialog } from "../components/Dialog.tsx";
import {
  exclusiveServices,
  initialServices,
  providerLabel,
  serviceLabel,
  sourcesFor,
  tenantChangeEffect,
  tenantChoice,
  tenantFromForm,
  toggleService,
  type ConnectorProviderView,
  type OAuthClientView,
  type SourceView,
  type TenantChoice,
} from "../lib/automation.ts";
import { ApiError } from "../lib/passkey-fetch.ts";
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
  const [services, setServices] = useState<string[]>(() => initialServices(p));
  const fitting = sourcesFor(p.service_kinds, services, sources);
  const [sourceId, setSourceId] = useState("");
  const chosen = fitting.some((s) => s.id === sourceId) ? sourceId : fitting[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const sourceFieldId = useId();
  const kinds = [...new Set(services.flatMap((s) => p.service_kinds[s] ?? []))];

  const toggle = (svc: string, on: boolean) => setServices((cur) => toggleService(p, cur, svc, on));

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
              {/* Services that go into sources of different kinds connect one at a time: a single choice. */}
              {p.services.map((svc) => (
                <label key={svc} className="checkbox-label">
                  {exclusiveServices(p)
                    ? <input type="radio" name={`${sourceFieldId}-service`} checked={services.includes(svc)} onChange={() => setServices([svc])} />
                    : <input type="checkbox" checked={services.includes(svc)} onChange={(e) => toggle(svc, e.target.checked)} />}
                  {serviceLabel(p.id, svc)}
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
          <code>memrain sources register &lt;id&gt; --kind {kinds[0] ?? "calendar"} --path-prefix &lt;prefix&gt;/</code>, add it to the read
          sources of the agents that should see it, then reload this page.
        </p>
      )}

      {p.auth === "oauth" && <OwnAppSettings provider={p} client={client} onDone={onDone} onError={onError} />}
    </section>
  );
}

const TENANT_OPTIONS: ReadonlyArray<{ value: TenantChoice; label: string }> = [
  { value: "common", label: "Work, school and personal accounts (common)" },
  { value: "organizations", label: "Work or school accounts only (organizations)" },
  { value: "consumers", label: "Personal accounts only (consumers)" },
  { value: "tenant", label: "One organization: its directory ID or domain" },
];

/** How a saved app's tenant reads next to its client id. */
function tenantSummary(tenant: string | null, fallback: string): string {
  const t = tenant ?? fallback;
  const option = TENANT_OPTIONS.find((o) => o.value === t);
  return option ? option.label.replace(/ \(.*\)$/, "").toLowerCase() : `directory ${t}`;
}

/** Who may sign in to the app: an audience, or one directory by id or domain. It must match the app's supported account types. */
function TenantFields({ choice, directory, invalid, onChoice, onDirectory }: {
  choice: TenantChoice;
  directory: string;
  invalid: boolean;
  onChoice: (c: TenantChoice) => void;
  onDirectory: (v: string) => void;
}) {
  const whoField = useId();
  const dirField = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={whoField}>Who can sign in</label>
        <select id={whoField} value={choice} onChange={(e) => onChoice(e.target.value as TenantChoice)}>
          {TENANT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="hint">It must match the app's supported account types. To read a personal and a work account with one app, choose common.</p>
      </div>
      {choice === "tenant" && (
        <div className="field">
          <label htmlFor={dirField}>Directory (tenant) ID or domain</label>
          <input
            id={dirField}
            value={directory}
            autoComplete="off"
            spellCheck={false}
            placeholder="contoso.onmicrosoft.com"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${dirField}-error` : undefined}
            onChange={(e) => onDirectory(e.target.value)}
          />
          {invalid && (
            <p className="error-text" id={`${dirField}-error`}>
              Enter a directory ID like 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d, or a domain like contoso.onmicrosoft.com.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** What the server said a confirmed app change would strand: how many accounts, and for a tenant change, from where to where. */
interface ReplaceAsk {
  accounts: number;
  change: "app" | "tenant" | "remove";
  from: string;
  to: string;
}

function replaceAsk(body: Record<string, unknown>): ReplaceAsk {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    accounts: typeof body.accounts === "number" ? body.accounts : 1,
    change: body.change === "tenant" || body.change === "remove" ? body.change : "app",
    from: text(body.tenant_from),
    to: text(body.tenant_to),
  };
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
  const [askReplace, setAskReplace] = useState<ReplaceAsk | null>(null);
  const idField = useId();
  const secretField = useId();
  const tenants = p.tenant_default !== null;
  const [choice, setChoice] = useState<TenantChoice>(() => tenantChoice(client?.tenant ?? null, p.tenant_default ?? "common"));
  const [directory, setDirectory] = useState(() => (client?.tenant && tenantChoice(client.tenant, "common") === "tenant" ? client.tenant : ""));
  const tenant = tenants ? tenantFromForm(choice, directory) : null;
  const tenantBad = tenants && choice === "tenant" && directory.trim() !== "" && tenant === null;

  const save = async (confirmReplace = false) => {
    setAskReplace(null);
    setBusy(true);
    try {
      await automationApi.saveClient(p.id, clientId.trim(), secret, tenants ? tenant ?? undefined : undefined, confirmReplace);
      setClientId("");
      setSecret("");
      onDone(confirmReplace
        ? `Saved your ${name} app. Reconnect every ${name} account so it keeps syncing.`
        : `Saved your ${name} app. New connections and renewals use it.`);
    } catch (e) {
      // Another app id or tenant while accounts depend on the current one: say what it costs, then ask.
      if (e instanceof ApiError && e.code === "client_replace_requires_confirm") {
        setAskReplace(replaceAsk(e.body));
      } else {
        onError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setAskRemove(false);
    setBusy(true);
    try {
      // The dialog is the confirmation the server asks for when accounts renew with the app.
      await automationApi.deleteClient(p.id, true);
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
            Using <span className="mono">{client.client_id}</span>
            {tenants && <>, {tenantSummary(client.tenant, p.tenant_default ?? "common")}</>}, saved {new Date(client.updated_at).toLocaleDateString()}.{" "}
            <button className="btn-link" disabled={busy} onClick={() => setAskRemove(true)}>Remove</button>
          </p>
        )}
        {p.callback_uri ? (
          <div className="own-app-callback">
            <span className="field-label">
              {p.id === "microsoft" ? "Register this redirect URI in the app, as a Web platform" : "Register this redirect URL in the app"}
            </span>
            <CopyField value={p.callback_uri} label={`Callback URL for ${name}`} />
          </div>
        ) : (
          <p className="hint">Set <code>MEMRAIN_PUBLIC_URL</code> to the brain's https address first; the redirect URL is built from it.</p>
        )}
        {p.id === "microsoft" && (
          <p className="hint">
            The client ID is the app's Application (client) ID on its Overview page. The secret is the Value column under
            Certificates &amp; secrets, shown once when you add it; the Secret ID beside it is not the secret.
          </p>
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
          {tenants && (
            <TenantFields
              choice={choice}
              directory={directory}
              invalid={tenantBad}
              onChoice={setChoice}
              onDirectory={setDirectory}
            />
          )}
          <button
            className="btn btn-secondary"
            type="submit"
            disabled={busy || clientId.trim() === "" || secret === "" || (tenants && tenant === null)}
          >
            {client ? "Replace app" : "Save app"}
          </button>
        </form>
      </div>
      {askReplace !== null && askReplace.change === "tenant" && (
        <Dialog title={`Change who can sign in to your ${name} app?`} onClose={() => setAskReplace(null)}>
          <p className="dialog-text">
            {askReplace.accounts === 1 ? "One connected account renews" : `${askReplace.accounts} connected accounts renew`} its access
            through <span className="mono">{askReplace.from}</span>. After the change every connected {name} account stops syncing
            until you choose <strong>Reconnect</strong> on its row. {tenantChangeEffect(askReplace.to)}
          </p>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setAskReplace(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void save(true)}>Change tenant</button>
          </div>
        </Dialog>
      )}
      {askReplace !== null && askReplace.change !== "tenant" && (
        <Dialog title={`Replace your ${name} app?`} onClose={() => setAskReplace(null)}>
          <p className="dialog-text">
            {askReplace.accounts === 1 ? "One connected account renews" : `${askReplace.accounts} connected accounts renew`} its access with
            {client ? <> <span className="mono">{client.client_id}</span></> : " the server's app"}. Access granted to one app cannot be
            renewed by another, so after the replacement every connected {name} account stops syncing until you choose
            {" "}<strong>Reconnect</strong> on its row. To renew an expiring secret, keep the same client ID: that needs no reconnect.
          </p>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setAskReplace(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void save(true)}>Replace app</button>
          </div>
        </Dialog>
      )}
      {askRemove && client && (
        <Dialog title={`Remove your ${name} app?`} onClose={() => setAskRemove(false)}>
          <p className="dialog-text">
            <span className="mono">{client.client_id}</span> and its secret are forgotten. New connections fall back to the
            server's app, if one is configured. Connected {name} accounts that renew with this app stop syncing until you
            choose <strong>Reconnect</strong> on their rows.
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
