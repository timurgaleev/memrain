import { useEffect, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { useAsync, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo, fmtInt, fmtUsd } from "../lib/format.ts";
import {
  accountView,
  connectOutcome,
  providerLabel,
  type ConnectorAccountView,
  type ConnectorsReport,
} from "../lib/automation.ts";
import { DeleteDataDialog, DisconnectDialog } from "./ConnectionDialogs.tsx";
import { ProviderPanel } from "./ConnectionProviders.tsx";
import { actionError, goToConsent } from "./connection-actions.ts";

type Flash = { ok: boolean; message: string };
type Open = { kind: "disconnect" | "delete"; account: ConnectorAccountView } | null;

export function ConnectionsPage() {
  const report = useAsync<ConnectorsReport>(() => automationApi.connectors(), [], { intervalMs: 60_000 });
  const [flash, setFlash] = useState<Flash | null>(null);
  const [open, setOpen] = useState<Open>(null);

  // A finished connect lands here with its outcome in the query. Read it once,
  // then drop it so a reload does not announce it again.
  useEffect(() => {
    const outcome = connectOutcome(window.location.search);
    if (!outcome) return;
    setFlash(outcome);
    history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  const done = (message: string) => {
    setFlash({ ok: true, message });
    report.reload();
  };
  const failed = (e: unknown) => setFlash({ ok: false, message: actionError(e) });

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Connections</h1>
          <PageIntro>
            Outside accounts Memrain reads from, with read-only access. A new account stays idle until you switch its sync
            on. Disconnecting revokes access and keeps the pages; deleting them is a separate step.
          </PageIntro>
        </div>
      </div>

      {flash && (
        <div className={flash.ok ? "notice" : "warning-bar"} role={flash.ok ? "status" : "alert"}>
          {flash.message}
          <button className="btn-link flash-dismiss" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}

      <Section state={report}>
        {(r) => (
          <>
            {!r.enabled && (
              <div className="warning-bar" role="status">
                Connectors are off{r.reason ? `: ${r.reason}` : ""}. Connecting, reconnecting and disconnecting wait until
                {" "}<code>MEMRAIN_CONNECTORS_ENABLED=1</code> is set and the connector key loads. Sync switches, held items and
                deleting an account's data still work.
              </div>
            )}

            <h2 className="section-title">Accounts</h2>
            <section className="panel">
              {r.accounts.length === 0 ? (
                <div className="empty-note">
                  No accounts yet. Connect one below; nothing is read until you switch its sync on.
                </div>
              ) : (
                <ul className="account-list">
                  {r.accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      connectorsOn={r.enabled}
                      onOpen={(kind) => setOpen({ kind, account: a })}
                      onDone={done}
                      onError={failed}
                    />
                  ))}
                </ul>
              )}
            </section>

            <h2 className="section-title">Connect an account</h2>
            {r.providers.length === 0 ? (
              <section className="panel">
                <div className="empty-note">No connector providers are installed on this server yet.</div>
              </section>
            ) : (
              r.providers.map((p) => (
                <ProviderPanel
                  key={p.id}
                  provider={p}
                  sources={r.sources}
                  client={r.clients.find((c) => c.provider === p.id) ?? null}
                  connectorsOn={r.enabled}
                  onDone={done}
                  onError={failed}
                />
              ))
            )}
          </>
        )}
      </Section>

      {open?.kind === "disconnect" && (
        <DisconnectDialog
          account={open.account}
          onClose={() => setOpen(null)}
          onDone={(message) => { setOpen(null); done(message); }}
          onChanged={report.reload}
        />
      )}
      {open?.kind === "delete" && (
        <DeleteDataDialog
          account={open.account}
          initialName=""
          onClose={() => setOpen(null)}
          onDone={(message) => { setOpen(null); done(message); }}
        />
      )}
    </>
  );
}

function AccountRow({ account: a, connectorsOn, onOpen, onDone, onError }: {
  account: ConnectorAccountView;
  connectorsOn: boolean;
  onOpen: (kind: "disconnect" | "delete") => void;
  onDone: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const now = useNow(30_000);
  const view = accountView(a);
  const [busy, setBusy] = useState(false);
  const [askDeletes, setAskDeletes] = useState(false);
  const reconnectNotice = a.notices.find((n) => n.kind === "needs_reconnect");

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const message = await work();
      if (message) onDone(message);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleSync = () => run(async () => {
    const r = await automationApi.setSync(a.id, !a.enabled);
    return r.enabled ? `Sync is on for ${a.account_label}.` : `Sync is off for ${a.account_label}. Its pages stay.`;
  });
  const reconnect = () => run(async () => {
    await goToConsent(a.provider, a.source_id, a.services);
    return null;
  });
  const confirmDeletes = () => run(async () => {
    setAskDeletes(false);
    const r = await automationApi.confirmDeletes(a.id);
    return `Confirmed: ${fmtInt(r.confirmed)} items gone upstream are deleted on the next sync.`;
  });
  const keepDeletes = () => run(async () => {
    const r = await automationApi.rejectDeletes(a.id);
    return `Kept ${fmtInt(r.kept)} items. A later sync asks again only if they are still gone.`;
  });
  const retryHeld = () => run(async () => {
    const r = await automationApi.retryHeld(a.id);
    return `${fmtInt(r.retried)} held items will be tried again on the next sync.`;
  });

  return (
    <li className="account-row" aria-busy={busy}>
      <div className="account-head">
        <span className={`dot dot-${view.tone}`} aria-hidden="true" />
        <span className="account-name mono">{a.account_label}</span>
        <span className="account-state">{view.label}</span>
        <span className="muted small">
          {providerLabel(a.provider)} · {a.services.join(", ")} · into <span className="mono">{a.source_id}</span>
        </span>
      </div>

      <dl className="kv account-meta">
        <dt>Last sync</dt><dd>{a.last_success_at ? fmtAgo(a.last_success_at, now) : "never"}</dd>
        <dt>Daily caps</dt><dd className="num">{fmtUsd(a.spend_cap_usd_daily)} · {fmtInt(a.item_cap_daily)} items</dd>
        <dt>Access</dt><dd className="mono account-scopes">{a.credential ? a.credential.scopes.join(" ") || "none" : "no credential"}</dd>
      </dl>

      {view.canReconnect && (
        <div className="account-attention warning-bar">
          {reconnectNotice?.detail ?? "The provider no longer accepts the stored access."} Sync is paused and nothing was
          deleted; reconnecting picks up where it stopped.
        </div>
      )}
      {a.held_deletes > 0 && (
        <div className="account-attention warning-bar">
          <span>
            {view.attention.find((t) => t.includes("deletion"))}: one sync run wanted to delete more than the safety limit allows.
            Nothing is deleted until you choose.
          </span>
          <span className="attention-actions">
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setAskDeletes(true)}>Delete the {a.held_deletes} items</button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={keepDeletes}>Keep them</button>
          </span>
        </div>
      )}
      {a.held_items > 0 && (
        <div className="account-attention warning-bar">
          <span>{view.attention.find((t) => t.includes("item"))}: they failed or were too large to store.</span>
          <span className="attention-actions">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={retryHeld}>Retry held items</button>
          </span>
        </div>
      )}

      <div className="account-actions">
        {view.canReconnect && (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !connectorsOn}
            aria-label={`Reconnect ${a.account_label}`}
            onClick={reconnect}
          >
            Reconnect
          </button>
        )}
        {view.canToggleSync && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            aria-label={`Turn sync ${a.enabled ? "off" : "on"} for ${a.account_label}`}
            onClick={toggleSync}
          >
            {a.enabled ? "Turn sync off" : "Turn sync on"}
          </button>
        )}
        {view.canDisconnect && (
          <button
            className="btn btn-danger btn-sm"
            disabled={busy || !connectorsOn}
            aria-label={`Disconnect ${a.account_label}`}
            onClick={() => onOpen("disconnect")}
          >
            Disconnect…
          </button>
        )}
        {view.canDeleteData && (
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            aria-label={`Delete everything ${a.account_label} brought in`}
            onClick={() => onOpen("delete")}
          >
            Delete its data…
          </button>
        )}
      </div>

      {askDeletes && (
        <Dialog title={`Delete ${a.held_deletes} items from ${a.account_label}?`} onClose={() => setAskDeletes(false)}>
          <p className="dialog-text">
            {providerLabel(a.provider)} no longer has them, or they aged out of the retention window. The next sync deletes their pages, chunks, vectors and facts for
            good and keeps a receipt without their text.
          </p>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setAskDeletes(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={confirmDeletes}>Delete {a.held_deletes} items</button>
          </div>
        </Dialog>
      )}
    </li>
  );
}
