import { useEffect, useId, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { Dialog } from "../components/Dialog.tsx";
import { ApiError } from "../lib/passkey-fetch.ts";
import { fmtInt } from "../lib/format.ts";
import { confirmMatches, deleteOutcome, disconnectConsentNote, providerLabel, type ConnectorAccountView, type DataPreview } from "../lib/automation.ts";
import { actionError } from "./connection-actions.ts";

function NameConfirm({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="confirm-field">
      <label htmlFor={id}>Type the account name to confirm</label>
      <p className="hint" id={`${id}-hint`}>It is <span className="mono">{label}</span>.</p>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
      />
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/**
 * Disconnect: revoke upstream, drop the credential, keep the pages. With the
 * box ticked, the dialog goes on to the preview-then-delete step. A provider
 * that gives the app no way to revoke (Microsoft) keeps the consent until the
 * owner removes it there, and the dialog says where.
 */
export function DisconnectDialog({ account, canRevoke, onClose, onDone, onChanged }: {
  account: ConnectorAccountView;
  /** Whether the provider lets Memrain withdraw the grant itself. */
  canRevoke: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
  /** The account changed underneath the page (it is disconnected now). */
  onChanged: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [thenDelete, setThenDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [next, setNext] = useState<{ kept: boolean } | null>(null);
  const deleteId = useId();
  const consent = disconnectConsentNote(account.provider, canRevoke);

  if (next) {
    return (
      <DeleteDataDialog
        account={account}
        initialName={typed}
        lead={next.kept
          ? `${providerLabel(account.provider)} did not confirm the revoke, so the credential is kept for another Disconnect. Its pages can still be deleted.`
          : consent ? `${account.account_label} is disconnected and Memrain deleted its access. ${consent}` : `${account.account_label} is disconnected.`}
        onClose={onClose}
        onDone={onDone}
      />
    );
  }

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await automationApi.disconnect(account.id, typed);
      if (thenDelete) {
        onChanged();
        setNext({ kept: r.credential_kept });
        return;
      }
      onDone(r.credential_kept
        ? `${providerLabel(account.provider)} did not confirm the revoke. The credential is kept so Disconnect can be tried again; sync is off.`
        : consent
          ? `${account.account_label} is disconnected and Memrain deleted its access. Its pages stay in the brain. ${consent}`
          : `${account.account_label} is disconnected. Its pages stay in the brain.`);
    } catch (e) {
      setError(actionError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Disconnect ${account.account_label}?`} onClose={onClose}>
      {consent ? (
        <>
          <p className="dialog-text">
            Memrain deletes its stored access to {providerLabel(account.provider)} and stops syncing. Pages it already brought in
            stay searchable.
          </p>
          <p className="dialog-text">{consent}</p>
        </>
      ) : (
        <p className="dialog-text">
          Memrain revokes its access at {providerLabel(account.provider)}, forgets the credential and stops syncing. Pages it
          already brought in stay searchable.
        </p>
      )}
      <p className="hint">To pause for a while instead, close this and use Turn sync off: reconnecting means consenting again.</p>
      <NameConfirm label={account.account_label} value={typed} onChange={setTyped} />
      <label className="checkbox-label" htmlFor={deleteId}>
        <input id={deleteId} type="checkbox" checked={thenDelete} onChange={(e) => setThenDelete(e.target.checked)} />
        Then delete everything it brought in (you see what first)
      </label>
      {error && <p className="error-text dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || !confirmMatches(typed, account.account_label)} onClick={submit}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Delete everything a disconnected account brought in. The counts come from a
 * preview, and the delete carries the preview's hash: if the data changed in
 * between, the server refuses and the dialog shows the new counts.
 */
export function DeleteDataDialog({ account, initialName, lead, onClose, onDone }: {
  account: ConnectorAccountView;
  initialName: string;
  lead?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [typed, setTyped] = useState(initialName);
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setPreview(null);
    try {
      setPreview(await automationApi.preview(account.id));
    } catch (e) {
      setError(actionError(e));
    }
  };
  useEffect(() => { void load(); }, [account.id]);

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await automationApi.deleteData(account.id, typed, preview.plan_hash);
      const outcome = deleteOutcome(r, account.account_label);
      if (outcome.done) {
        onDone(outcome.message);
      } else {
        // The pages edited after the preview are still there: stay open on a fresh preview of them.
        setError(outcome.message);
        void load();
      }
    } catch (e) {
      setError(actionError(e));
      if (e instanceof ApiError && e.code === "conflict") void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Delete everything from ${account.account_label}?`} onClose={onClose}>
      {lead && <p className="dialog-text">{lead}</p>}
      {preview === null ? (
        error ? null : <div className="skeleton" aria-busy="true" aria-label="Counting what would be deleted"><span /><span /></div>
      ) : (
        <>
          <p className="dialog-text">
            {preview.pages === 0 ? "Nothing this account brought in is left in the brain." : "This cannot be undone. It removes:"}
          </p>
          <dl className="kv preview-counts">
            <dt>Pages</dt><dd className="num">{plural(preview.pages, "page", "pages")}</dd>
            <dt>Chunks and vectors</dt><dd className="num">{fmtInt(preview.chunks)}</dd>
            <dt>Facts</dt><dd className="num">{fmtInt(preview.facts)}</dd>
            <dt>Timeline events</dt><dd className="num">{fmtInt(preview.timeline_events)}</dd>
          </dl>
          <NameConfirm label={account.account_label} value={typed} onChange={setTyped} />
        </>
      )}
      {error && <p className="error-text dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose}>{preview?.pages === 0 ? "Close" : "Cancel"}</button>
        {preview !== null && preview.pages > 0 && (
          <button className="btn btn-danger" disabled={busy || !confirmMatches(typed, account.account_label)} onClick={submit}>
            {busy ? "Deleting…" : `Delete ${plural(preview.pages, "page", "pages")}`}
          </button>
        )}
      </div>
    </Dialog>
  );
}
