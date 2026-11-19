import { useEffect, useId, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { ApiError } from "../lib/passkey-fetch.ts";
import { fmtInt } from "../lib/format.ts";
import { MAX_HISTORY_DAYS, providerLabel, type CalendarsReport, type ConnectorAccountView } from "../lib/automation.ts";
import { actionError } from "./connection-actions.ts";

const ROLE_LABELS: Record<string, string> = { owner: "you own it", writer: "you can edit it", reader: "read only" };

/** A whole number of days the server accepts, or null. */
function parseDays(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_HISTORY_DAYS ? n : null;
}

/** The server's own sentence for a refusal it explained, else the shared copy. */
function pickerError(e: unknown): string {
  if (e instanceof ApiError && typeof e.body.message === "string" && e.body.message !== "") return e.body.message;
  return actionError(e);
}

/**
 * Which of a Google or Microsoft account's calendars sync, and how far back a
 * calendar's first sync reads. The list comes from the provider with the
 * account's own access; primary always syncs and cannot be unticked.
 */
export function CalendarPicker({ account, id, onClose, onSaved }: {
  account: ConnectorAccountView;
  id: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [report, setReport] = useState<CalendarsReport | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const daysId = useId();

  useEffect(() => {
    let live = true;
    automationApi.calendars(account.id).then((r) => {
      if (!live) return;
      setReport(r);
      setChosen(new Set(r.calendars.filter((c) => c.selected && !c.primary).map((c) => c.id)));
      setDays(String(r.history_days));
    }).catch((e: unknown) => { if (live) setError(pickerError(e)); });
    return () => { live = false; };
  }, [account.id]);

  const toggle = (calendarId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(calendarId);
    else next.delete(calendarId);
    setChosen(next);
  };

  const historyDays = parseDays(days);
  const save = async () => {
    if (report === null || historyDays === null) return;
    setBusy(true);
    setError("");
    try {
      const secondary = report.calendars.filter((c) => !c.primary && chosen.has(c.id)).map((c) => c.id);
      await automationApi.saveCalendars(account.id, secondary, historyDays);
      const total = secondary.length + (report.calendars.some((c) => c.primary) ? 1 : 0);
      onSaved(`Saved: ${fmtInt(total)} ${total === 1 ? "calendar syncs" : "calendars sync"} for ${account.account_label}. The next sync picks them up.`);
    } catch (e) {
      setError(pickerError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="calendar-picker" id={id}>
      {report === null ? (
        error ? null : <div className="skeleton" aria-busy="true" aria-label="Loading the calendars this account can read"><span /><span /></div>
      ) : (
        <form className="calendar-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <fieldset className="calendar-list">
            <legend>Calendars to sync</legend>
            {report.calendars.length === 0 && <p className="empty-note">{providerLabel(account.provider)} lists no calendar this account can read.</p>}
            {report.calendars.map((c) => (
              <label key={c.id} className="checkbox-label calendar-option">
                <input
                  type="checkbox"
                  checked={c.primary || chosen.has(c.id)}
                  disabled={c.primary || busy}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
                <span className="calendar-name">{c.summary}</span>
                <span className="muted small">{c.primary ? "primary, always synced" : ROLE_LABELS[c.access_role] ?? c.access_role}</span>
              </label>
            ))}
          </fieldset>
          <div className="field calendar-days">
            <label htmlFor={daysId}>History window in days</label>
            <input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_HISTORY_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-invalid={historyDays === null}
              aria-describedby={`${daysId}-hint`}
            />
          </div>
          <p className="hint" id={`${daysId}-hint`}>
            How far back a calendar's first sync reads, from 1 to {fmtInt(MAX_HISTORY_DAYS)} days. A calendar that has
            already synced keeps the window it started with.
          </p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || historyDays === null}>
              {busy ? "Saving…" : "Save calendars"}
            </button>
          </div>
        </form>
      )}
      {report === null && error && (
        <>
          <p className="error-text" role="alert">{error}</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}
